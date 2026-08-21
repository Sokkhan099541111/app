import re
import requests
import json
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session


def get_all_employees(db: Session) -> list:
    """
    Select all rows from the `employee` table in the app_hosting MySQL
    database. Returns a list of dicts (column name -> value) so callers
    don't need to know the table's exact schema up front.
    """
    result = db.execute(text("SELECT * FROM employees"))
    return [dict(row._mapping) for row in result]


def get_employees_by_vehicle_ids(db: Session, vehicle_ids: list) -> dict:
    """
    Look up employees assigned to a set of vehicles, joined on
    `employees.vehicles_id` (the Wialon unit ID). Returns full_name (via
    CONCAT), phone_number, and driving_license per vehicle_id.

    Returns {vehicles_id: {"full_name": ..., "phone_number": ..., "driving_license": ...}}.
    """
    if not vehicle_ids:
        return {}

    placeholders = ", ".join(f":id{i}" for i in range(len(vehicle_ids)))
    params = {f"id{i}": vid for i, vid in enumerate(vehicle_ids)}
    query = text(
        f"""
        SELECT vehicles_id, CONCAT(first_name, ' ', last_name) AS full_name,
               phone_number, driving_license
        FROM employees
        WHERE vehicles_id IN ({placeholders})
        """
    )
    result = db.execute(query, params)
    return {
        row.vehicles_id: {
            "full_name": row.full_name,
            "phone_number": row.phone_number,
            "driving_license": row.driving_license,
        }
        for row in result
    }


def get_operation_logs_by_vehicle_ids(
    db: Session, vehicle_ids: list, start_date: str, end_date: str
) -> dict:
    """
    Aggregate `vehicle_operation_logs` rows for a set of vehicles over an
    operation_date range, joined on vehicle_operation_logs.vehicle_id ==
    the Wialon unit ID (the same "key" used everywhere else in
    /reports/vehicles).

    There can be multiple log rows per vehicle within a date range (e.g.
    one per day), so this aggregates per vehicle:
      - start_time: earliest start_time in the range
      - end_time: latest end_time in the range
      - working_hours: computed as (end_time - start_time) in decimal
        hours, using the aggregated start/end above -- NOT a sum of the
        table's per-row working_hours column, so it always matches what's
        displayed for Start Time/End Time.
      - initial_mileage: earliest (lowest) odometer reading in the range
      - final_mileage: latest (highest) odometer reading in the range
      - total_mileage: final_mileage - initial_mileage (matches the
        table's own `distance_travelled` generated column, computed here
        over the aggregated range instead of summed per-row)
      - fuel_filling_liters: summed across the range
      - remarks: all distinct remarks in the range joined with "; "
        (GROUP_CONCAT ignores NULLs/blank rows automatically)

    Returns {vehicle_id: {...}}. start_date/end_date are "YYYY-MM-DD"
    strings (matched against the DATE column `operation_date`).
    """
    if not vehicle_ids:
        return {}

    placeholders = ", ".join(f":id{i}" for i in range(len(vehicle_ids)))
    params = {f"id{i}": vid for i, vid in enumerate(vehicle_ids)}
    params["start_date"] = start_date
    params["end_date"] = end_date

    query = text(
        f"""
        SELECT vehicle_id,
               MIN(start_time) AS start_time,
               MAX(end_time) AS end_time,
               MIN(initial_mileage) AS initial_mileage,
               MAX(final_mileage) AS final_mileage,
               SUM(fuel_filling_liters) AS fuel_filling_liters,
               GROUP_CONCAT(DISTINCT remarks SEPARATOR '; ') AS remarks
        FROM vehicle_operation_logs
        WHERE vehicle_id IN ({placeholders})
          AND operation_date BETWEEN :start_date AND :end_date
        GROUP BY vehicle_id
        """
    )
    result = db.execute(query, params)
    logs = {}
    for row in result:
        working_hours = 0.0
        if row.start_time and row.end_time:
            working_hours = round(
                (row.end_time - row.start_time).total_seconds() / 3600, 2
            )
        initial_mileage = float(row.initial_mileage) if row.initial_mileage is not None else 0.0
        final_mileage = float(row.final_mileage) if row.final_mileage is not None else 0.0
        logs[row.vehicle_id] = {
            "start_time": row.start_time.isoformat() if row.start_time else "",
            "end_time": row.end_time.isoformat() if row.end_time else "",
            "working_hours": working_hours,
            "initial_mileage": initial_mileage,
            "final_mileage": final_mileage,
            "total_mileage": round(final_mileage - initial_mileage, 2),
            "fuel_filling_liters": float(row.fuel_filling_liters) if row.fuel_filling_liters is not None else 0.0,
            "remarks": row.remarks or "",
        }
    return logs


def get_wialon_credentials(db: Session, company_id: int) -> dict:
    """
    Look up the Wialon API token + base_url for a given company from
    `company_wialon_credentials` (app_hosting MySQL DB). Each company can
    have its own token/base_url, so callers must always resolve this
    per-request instead of relying on a single global WIALON_TOKEN.

    Raises HTTPException(404) if the company has no active row on file.
    """
    query = text(
        """
        SELECT wialon_token, base_url
        FROM company_wialon_credentials
        WHERE company_id = :company_id AND is_active = 1
        LIMIT 1
        """
    )
    try:
        row = db.execute(query, {"company_id": company_id}).first()
    except SQLAlchemyError as e:
        # Most likely cause: company_wialon_credentials.sql hasn't been run
        # against app_hosting yet, so the table doesn't exist. Surface this
        # as a clear message instead of a bare 500/stack trace.
        raise HTTPException(
            status_code=500,
            detail=(
                "Could not read company_wialon_credentials -- has "
                "company_wialon_credentials.sql been run against the "
                f"app_hosting database yet? ({e.__class__.__name__}: {e})"
            ),
        )
    if not row:
        raise HTTPException(
            status_code=404,
            detail=f"No active Wialon credentials found for company_id={company_id}",
        )
    return {
        "wialon_token": row.wialon_token,
        "base_url": row.base_url or "https://hst-api.wialon.com/wialon/ajax.html",
    }


class WialonReportService:
    def __init__(self, sid: str = "", base_url: str = None):
        self.sid = sid
        self.base_url = base_url or "https://hst-api.wialon.com/wialon/ajax.html"

    def login(self, token: str):
        params = {"token": token, "operateAs": ""}
        response = self._call("token/login", params)
        self.sid = response["eid"]
        return self.sid

    # --- THIS MUST BE INDENTED TO BE INSIDE THE CLASS ---
    def _call(self, svc: str, params: dict):
        payload = {
            "svc": svc,
            "params": json.dumps(params),
            "sid": self.sid
        }
        try:
            response = requests.post(self.base_url, data=payload)
            response.raise_for_status()
            data = response.json()
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Connection Error: {str(e)}")

        if isinstance(data, dict) and "error" in data:
            print(f"DEBUG: Wialon API returned error for {svc}: {data}") 
            raise HTTPException(status_code=400, detail=f"Wialon API Error {data['error']} in {svc}")
        return data

    def run_report(self, resource_id: int, template_id: int, object_id: int, start: int, end: int):
        try:
            self._call("report/cleanup_result", {})
        except:
            print("Note: cleanup_result skipped (no report to clean)")

        exec_params = {
            "reportResourceId": resource_id,
            "reportTemplateId": template_id,
            "reportObjectId": object_id,
            "reportObjectSecId": 0,
            "interval": {"from": start, "to": end, "flags": 0}
        }
        
        self._call("report/exec_report", exec_params)
        return self._call("report/get_result_rows", {
            "tableIndex": 0, 
            "indexFrom": 0, 
            "indexTo": 100
        })
    
    # Add this method to your WialonReportService class in app/services/wialon_reports.py
#  "itemsType": "avl_unit",
# --- THIS LINE MUST BE INDENTED ---
    def get_objects(self):
        params = {
            "spec": {
                "itemsType": "avl_unit_group",
                "propName": "sys_name",
                "propValueMask": "*",
                "sortType": "sys_name"
            },
            "force": 1,
            "flags": 1,
            "from": 0,
            "to": 0
        }
        return self._call("core/search_items", params).get("items", [])

    def get_all_units(self) -> list:
        """
        Return every avl_unit (vehicle) in the Wialon account as
        {"id": ..., "name": ...}, account-wide -- not scoped to a unit
        group. Used to populate vehicle pickers (e.g. the vehicle
        operation log form's vehicle_id dropdown) without requiring the
        caller to already know which group a vehicle belongs to.
        """
        params = {
            "spec": {
                "itemsType": "avl_unit",
                "propName": "sys_name",
                "propValueMask": "*",
                "sortType": "sys_name",
            },
            "force": 1,
            "flags": 1,
            "from": 0,
            "to": 0,
        }
        items = self._call("core/search_items", params).get("items", [])
        return [{"id": item.get("id"), "name": item.get("nm", "")} for item in items]

    def get_group_units(self, group_id: int) -> list:
        """
        Return the member unit IDs for an avl_unit_group.
        flags=1 (base info) includes the "u" array of unit IDs for group items.
        """
        result = self._call("core/search_item", {"id": group_id, "flags": 1})
        return result.get("item", {}).get("u", [])

    def get_units_summary(self, unit_ids: list) -> list:
        """
        Fetch base info + custom/profile fields + last message for a
        specific list of unit IDs.
        flags = 1 (base) | 8 (custom fields "flds") | 16 (profile fields
        "pflds") | 1024 (last message) = 1049.
        NOTE: propValueMask accepts a comma-separated list of sys_id values.
        """
        if not unit_ids:
            return []

        params = {
            "spec": {
                "itemsType": "avl_unit",
                "propName": "sys_id",
                "propValueMask": ",".join(str(uid) for uid in unit_ids),
                "sortType": "sys_name",
            },
            "force": 1,
            "flags": 1049,
            "from": 0,
            "to": 0,
        }
        return self._call("core/search_items", params).get("items", [])

    @staticmethod
    def get_custom_field(unit: dict, *candidate_names: str) -> str:
        """
        Look up a value from a unit's custom fields ("flds": [{"n": name,
        "v": value}, ...]) or profile fields ("pflds": {id: {"n": name,
        "v": value}, ...}), trying each candidate name case-insensitively.
        Returns "" if nothing matches.

        NOTE: Wialon custom/profile field NAMES are account-specific --
        these candidate lists are best-effort guesses (common conventions
        like "code", "type", "type_kh"). If a column comes back blank,
        check an actual unit's flds/pflds in your Wialon account (Admin ->
        Units -> unit -> Custom fields / Profile) and add the real field
        name to the relevant candidate list where this is called below.
        """
        candidates_lower = {c.lower() for c in candidate_names}

        pflds = unit.get("pflds") or {}
        if isinstance(pflds, dict):
            for field in pflds.values():
                if isinstance(field, dict) and str(field.get("n", "")).lower() in candidates_lower:
                    return field.get("v", "")

        flds = unit.get("flds") or []
        if isinstance(flds, list):
            for field in flds:
                if str(field.get("n", "")).lower() in candidates_lower:
                    return field.get("v", "")

        return ""

    def build_vehicle_rows(self, units: list, group_name: str = "") -> list:
        """
        Map raw Wialon unit items into the row shape the Vehicle List table
        expects: plate, vehicle, driver, group, speed, mileage,engine, status.

        NOTE: "plate", "driver", and "mileage" are NOT standard base fields in
        Wialon's core/search_items response — they typically live in custom
        fields, unit profile fields, or sensor/counter values that vary per
        account. This maps the fields we can get from base info + last
        message (name, speed, last-message presence) and leaves the rest as
        placeholders. Update the TODOs below to match your actual Wialon
        field/sensor names once you confirm them (e.g. via core/search_item
        with flags including profile fields, or unit.sens).
        """
        rows = []
        for unit in units:
            last_msg = unit.get("lmsg") or {}
            pos = last_msg.get("pos") or {}
            speed = pos.get("s", 0)

            if not last_msg:
                status = "Offline"
            elif speed and speed > 0:
                status = "Moving"
            else:
                status = "Stopped"

            rows.append({
                "key": unit.get("id"),
                "plate": unit.get("nm"),      # TODO: replace with actual plate field
                "vehicle": unit.get("nm"),
                "code": "",                      # overlaid from the fleet report, see parse_report_metrics_by_name
                "vehicleTypeEng": "",            # overlaid from the fleet report, see parse_report_metrics_by_name
                "vehicleTypeKh": "",             # overlaid from the fleet report, see parse_report_metrics_by_name
                "baseLocation": "",              # overlaid from the fleet report, see parse_report_metrics_by_name
                "projectCode": "",               # overlaid from the fleet report, see parse_report_metrics_by_name
                "fullName": "",                # overlaid from employees table, joined on vehicles_id
                "phoneNumber": "",              # overlaid from employees table, joined on vehicles_id
                "drivingLicense": "",           # overlaid from employees table, joined on vehicles_id
                "group": group_name,
                "speed": speed,
                "mileage": 0,                    # overlaid from the fleet report, see parse_report_metrics_by_name
                "engineHours": 0,                # overlaid from the fleet report, see parse_report_metrics_by_name
                "initialFuel": 0,                # overlaid from the fleet report, see parse_report_metrics_by_name
                "fuelFilling": 0,                # overlaid from the fleet report, see parse_report_metrics_by_name
                "fuelConsumed": 0,                # overlaid from the fleet report, see parse_report_metrics_by_name
                "finalFuelLevel": 0,              # overlaid from the fleet report, see parse_report_metrics_by_name
                "fuelStandard": "",                # overlaid from the fleet report, see parse_report_metrics_by_name
                "startTime": "",                 # overlaid from vehicle_operation_logs, joined on vehicle_id
                "endTime": "",                   # overlaid from vehicle_operation_logs, joined on vehicle_id
                "workingHours": 0,               # overlaid from vehicle_operation_logs, joined on vehicle_id
                "initialMileage": 0,             # overlaid from vehicle_operation_logs, joined on vehicle_id
                "finalMileage": 0,               # overlaid from vehicle_operation_logs, joined on vehicle_id
                "totalMileage": 0,               # overlaid from vehicle_operation_logs, joined on vehicle_id
                "fuelFilledLiters": 0,           # overlaid from vehicle_operation_logs, joined on vehicle_id
                "remarks": "",                    # overlaid from vehicle_operation_logs, joined on vehicle_id
                "status": status,
            })
        return rows

    @staticmethod
    def normalize_name(name: str) -> str:
        """Collapse repeated whitespace and strip, so report row names match
        unit names even when Wialon formats them with inconsistent spacing
        (e.g. "CR09  3E-7476" vs "CR09 3E-7476")."""
        return re.sub(r"\s+", " ", str(name or "")).strip()

    @staticmethod
    def parse_km(value) -> float:
        """Parse a Wialon report cell like '273.48 km' into a float. Returns
        0.0 if the value can't be parsed (e.g. it's not a distance column)."""
        try:
            return float(str(value).replace("km", "").strip())
        except (ValueError, TypeError):
            return 0.0

    @staticmethod
    def parse_engine_hours(value) -> float:
        """Parse a Wialon duration cell like '8:32:17' (H:MM:SS) into
        decimal hours, e.g. 8.54. Returns 0.0 if it can't be parsed."""
        try:
            parts = str(value).strip().split(":")
            if len(parts) != 3:
                return 0.0
            hours, minutes, seconds = (int(p) for p in parts)
            return round(hours + minutes / 60 + seconds / 3600, 2)
        except (ValueError, TypeError):
            return 0.0

    @staticmethod
    def parse_initial_fuel(value) -> float:
        """Parse a Wialon fuel cell like '116.00 l' into a float. Returns
        0.0 if the value can't be parsed."""
        try:
            return float(str(value).lower().replace("l", "").strip())
        except (ValueError, TypeError):
            return 0.0

    def parse_report_metrics_by_name(self, report_rows: list) -> dict:
        """
        Build a {normalized_vehicle_name: {...}} map from a run_report()
        result.

        Column order confirmed from an actual 12-column response
        (template_id=21, as of the version you're currently running):
          index 0:  vehicle name             e.g. "CR15 3A-0751"
          index 1:  code                     e.g. "BZ04"
          index 2:  vehicle type (English)   e.g. "Crane Truck 3T"
          index 3:  vehicle type (Khmer)     e.g. "ក្រេន"
          index 4:  base location            e.g. "Phnom Penh"
          index 5:  project code             e.g. "003"
          index 6:  distance/mileage         e.g. "183.60 km"
          index 7:  engine hours (H:MM:SS)   e.g. "9:00:05"
          index 8:  fuel level at start (l)  e.g. "124.30 l"
          index 9:  fuel filled (l)          e.g. "58.50 l"
          index 10: fuel consumed (l)        e.g. "61.10 l"
          index 11: fuel level at end (l)    e.g. "121.70 l"
          index 12: fuel standard            e.g. "35L/100km", "12L/h",
                                              "14h/h", or a plain number
                                              like "9" -- units aren't
                                              consistent, so this is kept
                                              as a raw string, not parsed
                                              into a number.

        Fuel column semantics confirmed arithmetically across multiple
        rows: start - consumed + filled == end (e.g. 124.30 - 61.10 +
        58.50 = 121.70), so index 10 is consumed and index 11 is the
        final/end level.

        WARNING: this is positional parsing against a report template
        that's already changed shape 6 times in this project (4, then 5,
        then 9, then 11, then 12, then 13 columns) -- if the template is
        edited again in Wialon's Report Designer, these indices will need
        updating to match.
        """
        result = {}
        for row in report_rows or []:
            cols = row.get("c", [])
            if len(cols) < 8:
                continue
            name = self.normalize_name(cols[0])
            result[name] = {
                "code": cols[1] if len(cols) > 1 else "",
                "vehicleTypeEng": cols[2] if len(cols) > 2 else "",
                "vehicleTypeKh": cols[3] if len(cols) > 3 else "",
                "baseLocation": cols[4] if len(cols) > 4 else "",
                "projectCode": cols[5] if len(cols) > 5 else "",
                "mileage": self.parse_km(cols[6]),
                "engineHours": self.parse_engine_hours(cols[7]),
                "initialFuel": self.parse_initial_fuel(cols[8]) if len(cols) > 8 else 0.0,
                "fuelFilling": self.parse_initial_fuel(cols[9]) if len(cols) > 9 else 0.0,
                "fuelConsumed": self.parse_initial_fuel(cols[10]) if len(cols) > 10 else 0.0,
                "finalFuelLevel": self.parse_initial_fuel(cols[11]) if len(cols) > 11 else 0.0,
                "fuelStandard": cols[12] if len(cols) > 12 else "",
            }
        return result