"""
CRUD API for `employees`.

Table schema (see app/employees.sql for a fresh install, or
app/employees_migrate_split_name.sql + app/employees_add_vehicle_remove_bank.sql
+ app/employees_require_fields_drop_national_id.sql + app/employees_require_vehicles_id.sql
+ app/employees_drop_email.sql + app/employees_add_driving_license.sql to
migrate an existing table in place -- all six require app/departments.sql
and app/positions.sql to have been run first):

    employee_id             INT UNSIGNED AUTO_INCREMENT PK
    employee_code           VARCHAR(20)  NOT NULL             (unique, required)
    vehicles_id             INT NOT NULL                      -- Wialon avl_unit id, required
    first_name              VARCHAR(50)  NOT NULL
    last_name               VARCHAR(50)  NOT NULL
    gender                  ENUM('Mr.','Ms','Miss','Other') NOT NULL
    driving_license         ENUM('Yes','No') NOT NULL         -- required
    date_of_birth           DATE
    phone_number            VARCHAR(20)
    address                 VARCHAR(255)
    department_id           INT UNSIGNED NOT NULL            -- FK -> departments, required
    position_id             INT UNSIGNED NOT NULL            -- FK -> positions, required
    hire_date               DATE                              -- optional
    termination_date        DATE
    employment_status       ENUM('Active','Inactive','Terminated') NOT NULL DEFAULT 'Active'
    basic_salary            DECIMAL(12,2) NOT NULL           -- current monthly basic salary
    created_at              TIMESTAMP
    updated_at              TIMESTAMP

Every endpoint here also returns a computed `full_name` field
(CONCAT(first_name, ' ', last_name)) in every response, purely so the
several payroll/report frontend pages that already read `record.full_name`
keep working without changes -- create/update payloads must send
first_name and last_name separately, though.

The vehicle picker (vehicles_id) is populated from Wialon, not a local
table -- see GET /api/vehicle-logs/vehicle-options (already registered by
vehicle_operation_logs_route.py) for the {id, name} list.

Business rules:
  - employee_code, department_id, position_id, vehicles_id, and
    driving_license are all required on create -- every employee must be
    assigned a vehicle and have their driving license status recorded.
  - employee_code must be unique (checked on create/update, 409 if taken;
    also see GET /employees/check-code for the frontend's live check).
  - One vehicle can only be assigned to one non-Terminated employee at a
    time (checked on create/update, 409 if taken; see GET
    /employees/check-vehicle for the frontend's live check). Once an
    employee is Terminated, their vehicle frees up for reassignment (their
    own vehicles_id value isn't cleared, just no longer counted as "taken").
  - DELETE is a soft delete -- it sets employment_status to 'Terminated'
    (and fills in termination_date if it isn't already set) instead of
    removing the row, so employee history survives for payroll/audit
    purposes. The list endpoint shows every status unless a `status`
    filter is passed; the frontend defaults that filter to 'Active'.
  - GET /employees supports a free-text `search` param (matches
    employee_code, first_name, last_name, or phone_number) plus
    department_id/position_id/vehicle_id filters, on top of the existing
    employee_code/full_name/status filters -- combine whichever you need.
"""
from datetime import date
from enum import Enum
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config.database import get_db

router = APIRouter()


class GenderEnum(str, Enum):
    mr = "Mr."
    ms = "Ms"
    miss = "Miss"
    other = "Other"


class DrivingLicenseEnum(str, Enum):
    yes = "Yes"
    no = "No"


class EmploymentStatusEnum(str, Enum):
    active = "Active"
    inactive = "Inactive"
    terminated = "Terminated"


# --- Request bodies ----------------------------------------------------

class EmployeeIn(BaseModel):
    employee_code: str = Field(..., min_length=1)  # required -- must be provided on create, and unique
    vehicles_id: int  # required -- must be provided on create, one vehicle per non-Terminated employee
    first_name: str
    last_name: str
    gender: GenderEnum
    driving_license: DrivingLicenseEnum  # required -- must be provided on create
    date_of_birth: Optional[date] = None
    phone_number: Optional[str] = None
    address: Optional[str] = None
    department_id: int  # required -- must be provided on create
    position_id: int  # required -- must be provided on create
    hire_date: Optional[date] = None
    termination_date: Optional[date] = None
    employment_status: EmploymentStatusEnum = EmploymentStatusEnum.active
    basic_salary: float  # required -- must be provided on create


class EmployeeUpdate(BaseModel):
    """All fields optional -- only columns actually sent get updated."""
    employee_code: Optional[str] = Field(None, min_length=1)
    vehicles_id: Optional[int] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    gender: Optional[GenderEnum] = None
    driving_license: Optional[DrivingLicenseEnum] = None
    date_of_birth: Optional[date] = None
    phone_number: Optional[str] = None
    address: Optional[str] = None
    department_id: Optional[int] = None
    position_id: Optional[int] = None
    hire_date: Optional[date] = None
    termination_date: Optional[date] = None
    employment_status: Optional[EmploymentStatusEnum] = None
    basic_salary: Optional[float] = None


# --- Helpers -------------------------------------------------------------

# CONCAT(...) AS full_name -- kept purely so existing frontend pages that
# already read record.full_name (payroll/attendance pages, mostly) don't
# need to change; new code should prefer first_name/last_name directly.
_EMPLOYEE_SELECT = """
    SELECT e.*, CONCAT(e.first_name, ' ', e.last_name) AS full_name,
           d.name AS department_name, p.title AS position_title
    FROM employees e
    LEFT JOIN departments d ON d.department_id = e.department_id
    LEFT JOIN positions p ON p.position_id = e.position_id
"""


def _row_to_dict(row) -> dict:
    return dict(row._mapping)


def _fetch_employee(db: Session, employee_id: int) -> dict:
    row = db.execute(
        text(f"{_EMPLOYEE_SELECT} WHERE e.employee_id = :employee_id"),
        {"employee_id": employee_id},
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Employee {employee_id} not found")
    return _row_to_dict(row)


def _code_taken(db: Session, employee_code: Optional[str], exclude_employee_id: Optional[int] = None) -> bool:
    if not employee_code:
        return False
    params: dict = {"employee_code": employee_code}
    exclude_clause = ""
    if exclude_employee_id is not None:
        exclude_clause = "AND employee_id != :exclude_employee_id"
        params["exclude_employee_id"] = exclude_employee_id
    row = db.execute(
        text(
            f"SELECT 1 FROM employees WHERE employee_code = :employee_code {exclude_clause} LIMIT 1"
        ),
        params,
    ).first()
    return row is not None


def _vehicle_taken(
    db: Session, vehicles_id: Optional[int], exclude_employee_id: Optional[int] = None
) -> bool:
    """
    True if this vehicle is already assigned to another employee whose
    employment_status isn't 'Terminated' -- keeps the assignment one
    vehicle <-> one (current) employee. A Terminated employee's vehicle no
    longer counts, so it's free to hand to someone else.
    """
    if not vehicles_id:
        return False
    params: dict = {"vehicles_id": vehicles_id}
    exclude_clause = ""
    if exclude_employee_id is not None:
        exclude_clause = "AND employee_id != :exclude_employee_id"
        params["exclude_employee_id"] = exclude_employee_id
    row = db.execute(
        text(
            f"""
            SELECT 1 FROM employees
            WHERE vehicles_id = :vehicles_id
              AND employment_status != 'Terminated'
              {exclude_clause}
            LIMIT 1
            """
        ),
        params,
    ).first()
    return row is not None


# --- Routes --------------------------------------------------------------

@router.get("/employees")
def list_employees(
    employee_code: Optional[str] = Query(None, description="Filter by employee code (partial match)"),
    full_name: Optional[str] = Query(None, description="Filter by name (partial match, matches first or last name)"),
    search: Optional[str] = Query(
        None, description="Free-text search across employee_code, first_name, last_name, phone_number"
    ),
    vehicle_id: Optional[int] = Query(None, description="Filter by assigned vehicle (Wialon unit id)"),
    department_id: Optional[int] = Query(None, description="Filter by department"),
    position_id: Optional[int] = Query(None, description="Filter by position"),
    status: Optional[str] = Query(
        None,
        description="Filter by employment_status: Active, Inactive, or Terminated. "
        "'All' (or omitting this param) returns every status.",
    ),
    sort_by: str = Query(
        "full_name",
        description="Column to sort by: full_name, employee_code, hire_date, basic_salary, employment_status",
    ),
    sort_dir: str = Query("asc", description="asc or desc"),
    db: Session = Depends(get_db),
):
    """List employees, optionally filtered by code/name (partial match),
    a free-text search, assigned vehicle, department, position, and/or
    employment status. No filter is applied by default -- the frontend
    defaults the status dropdown to 'Active'."""
    if status is not None and status.strip().lower() != "all":
        normalized_status = status.strip().capitalize()
        if normalized_status not in ("Active", "Inactive", "Terminated"):
            raise HTTPException(
                status_code=400,
                detail="status must be one of: Active, Inactive, Terminated, All",
            )
    else:
        normalized_status = None

    allowed_sort = {"full_name", "employee_code", "hire_date", "basic_salary", "employment_status"}
    if sort_by not in allowed_sort:
        sort_by = "full_name"
    sort_dir = "DESC" if str(sort_dir).lower() == "desc" else "ASC"
    # full_name is a computed alias (CONCAT), not a real column -- sort by
    # the underlying columns instead so MySQL doesn't have to resolve an
    # alias in ORDER BY through the LEFT JOINs.
    order_expr = "e.first_name, e.last_name" if sort_by == "full_name" else f"e.{sort_by}"

    clauses = []
    params: dict = {}
    if employee_code:
        clauses.append("e.employee_code LIKE :employee_code")
        params["employee_code"] = f"%{employee_code}%"
    if full_name:
        clauses.append("(e.first_name LIKE :full_name OR e.last_name LIKE :full_name)")
        params["full_name"] = f"%{full_name}%"
    if search:
        clauses.append(
            "(e.employee_code LIKE :search OR e.first_name LIKE :search OR e.last_name LIKE :search "
            "OR e.phone_number LIKE :search)"
        )
        params["search"] = f"%{search}%"
    if vehicle_id is not None:
        clauses.append("e.vehicles_id = :vehicle_id")
        params["vehicle_id"] = vehicle_id
    if department_id is not None:
        clauses.append("e.department_id = :department_id")
        params["department_id"] = department_id
    if position_id is not None:
        clauses.append("e.position_id = :position_id")
        params["position_id"] = position_id
    if normalized_status is not None:
        clauses.append("e.employment_status = :status")
        params["status"] = normalized_status

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    try:
        rows = db.execute(
            text(f"{_EMPLOYEE_SELECT} {where} ORDER BY {order_expr} {sort_dir}"),
            params,
        )
        return {"status": "success", "data": [_row_to_dict(r) for r in rows]}
    except SQLAlchemyError as e:
        raise HTTPException(
            status_code=500,
            detail=(
                "Could not read employees -- have employees.sql (or "
                "employees_migrate_split_name.sql + "
                "employees_add_vehicle_remove_bank.sql), departments.sql, and "
                f"positions.sql all been run yet? ({e})"
            ),
        )


@router.get("/employees/check-code")
def check_employee_code(
    employee_code: str = Query(..., description="Employee code to check"),
    exclude_employee_id: Optional[int] = Query(
        None, description="Employee id to ignore (pass the record's own id when editing)"
    ),
    db: Session = Depends(get_db),
):
    """Lets the frontend check employee_code uniqueness as soon as the
    user types it, instead of waiting for the 409 on submit."""
    exists = _code_taken(db, employee_code, exclude_employee_id=exclude_employee_id)
    return {"status": "success", "exists": exists}


@router.get("/employees/check-vehicle")
def check_vehicle_assignment(
    vehicles_id: int = Query(..., description="Wialon unit id to check"),
    exclude_employee_id: Optional[int] = Query(
        None, description="Employee id to ignore (pass the record's own id when editing)"
    ),
    db: Session = Depends(get_db),
):
    """Lets the frontend check as soon as a vehicle is picked whether it's
    already assigned to another (non-Terminated) employee."""
    exists = _vehicle_taken(db, vehicles_id, exclude_employee_id=exclude_employee_id)
    return {"status": "success", "exists": exists}


@router.get("/employees/{employee_id}")
def get_employee(employee_id: int, db: Session = Depends(get_db)):
    return {"status": "success", "data": _fetch_employee(db, employee_id)}


@router.post("/employees", status_code=201)
def create_employee(payload: EmployeeIn, db: Session = Depends(get_db)):
    if _code_taken(db, payload.employee_code):
        raise HTTPException(
            status_code=409,
            detail=f"Employee code '{payload.employee_code}' is already in use.",
        )

    if payload.vehicles_id and _vehicle_taken(db, payload.vehicles_id):
        raise HTTPException(
            status_code=409,
            detail="This vehicle is already assigned to another employee.",
        )

    try:
        result = db.execute(
            text(
                """
                INSERT INTO employees
                    (employee_code, vehicles_id, first_name, last_name, gender, driving_license,
                     date_of_birth, phone_number, address, department_id, position_id,
                     hire_date, termination_date, employment_status, basic_salary)
                VALUES
                    (:employee_code, :vehicles_id, :first_name, :last_name, :gender, :driving_license,
                     :date_of_birth, :phone_number, :address, :department_id, :position_id,
                     :hire_date, :termination_date, :employment_status, :basic_salary)
                """
            ),
            payload.model_dump(),
        )
        db.commit()
        return {"status": "success", "data": _fetch_employee(db, result.lastrowid)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not create employee: {e}")


@router.put("/employees/{employee_id}")
def update_employee(employee_id: int, payload: EmployeeUpdate, db: Session = Depends(get_db)):
    _fetch_employee(db, employee_id)  # 404 early if it doesn't exist

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "employee_code" in updates and _code_taken(
        db, updates["employee_code"], exclude_employee_id=employee_id
    ):
        raise HTTPException(
            status_code=409,
            detail=f"Employee code '{updates['employee_code']}' is already in use.",
        )

    if "vehicles_id" in updates and _vehicle_taken(
        db, updates["vehicles_id"], exclude_employee_id=employee_id
    ):
        raise HTTPException(
            status_code=409,
            detail="This vehicle is already assigned to another employee.",
        )

    set_clause = ", ".join(f"{col} = :{col}" for col in updates)
    updates["employee_id"] = employee_id

    try:
        db.execute(
            text(f"UPDATE employees SET {set_clause} WHERE employee_id = :employee_id"),
            updates,
        )
        db.commit()
        return {"status": "success", "data": _fetch_employee(db, employee_id)}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not update employee {employee_id}: {e}")


@router.delete("/employees/{employee_id}")
def delete_employee(employee_id: int, db: Session = Depends(get_db)):
    """
    Soft delete: sets employment_status='Terminated' (and termination_date
    to today if it isn't already set) instead of removing the row, so the
    employee's history stays intact for payroll/audit purposes.
    """
    current = _fetch_employee(db, employee_id)  # 404 early if it doesn't exist
    try:
        if current.get("termination_date"):
            db.execute(
                text(
                    "UPDATE employees SET employment_status = 'Terminated' "
                    "WHERE employee_id = :employee_id"
                ),
                {"employee_id": employee_id},
            )
        else:
            db.execute(
                text(
                    "UPDATE employees SET employment_status = 'Terminated', "
                    "termination_date = CURDATE() WHERE employee_id = :employee_id"
                ),
                {"employee_id": employee_id},
            )
        db.commit()
        return {"status": "success", "message": f"Employee {employee_id} marked Terminated"}
    except SQLAlchemyError as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not delete employee {employee_id}: {e}")
