import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Spin, Result } from "antd";
import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import LoginPage from "../pages/LoginPage";
import AdminLayout from "../layouts/AdminLayout";
import Dashboard from "../pages/Dashboard";
import DailyActivities from "../pages/dailyActivities";
import VehicleOperationLogManagement from "../pages/VehicleOperationLogManagement";
import EmployeeManagement from "../pages/EmployeeManagement";
import DepartmentManagement from "../pages/DepartmentManagement";
import PositionManagement from "../pages/PositionManagement";
import SalaryHistoryManagement from "../pages/SalaryHistoryManagement";
import FoodPolicyManagement from "../pages/FoodPolicyManagement";
import PayrollPeriodManagement from "../pages/PayrollPeriodManagement";
import AttendanceManagement from "../pages/AttendanceManagement";
import AttendanceReport from "../pages/AttendanceReport";
import PayrollEntryManagement from "../pages/PayrollEntryManagement";
import PayslipReport from "../pages/PayslipReport";
import PayrollWorksheet from "../pages/PayrollWorksheet";
import RentalVehicleManagement from "../pages/RentalVehicleManagement";
import RentalAttendanceManagement from "../pages/RentalAttendanceManagement";
import RentalExpenseReport from "../pages/RentalExpenseReport";
import FormulaManagement from "../pages/FormulaManagement";
import DailyKpiManagement from "../pages/DailyKpiManagement";
import VendorManagement from "../pages/VendorManagement";
import VehicleExpenseManagement from "../pages/VehicleExpenseManagement";
import VehicleFinancialReport from "../pages/VehicleFinancialReport";
import CompanyWialonCredentialManagement from "../pages/CompanyWialonCredentialManagement";
import UserManagement from "../pages/UserManagement";
import RoleManagement from "../pages/RoleManagement";
import MenuManagement from "../pages/MenuManagement";

// Requires login, and (once the session has finished loading) that the
// requested path is actually one of the current user's permitted menus --
// this is what stops "access an unauthorized page by typing the URL
// directly" per the spec, not just hiding the sidebar link.
function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, loading, canAccessPath } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (!canAccessPath(location.pathname)) {
    return (
      <Result
        status="403"
        title="403"
        subTitle="You don't have access to this page."
        style={{ marginTop: 80 }}
      />
    );
  }

  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <Router>
        <Routes>
          {/* Public Route */}
          <Route path="/login" element={<LoginPage />} />

          {/* Protected Routes (Wrapped in your AdminLayout) */}
          <Route
            path="/*"
            element={
              <AdminLayout>
                <Routes>
                  <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
                  <Route path="/daily-activities" element={<ProtectedRoute><DailyActivities /></ProtectedRoute>} />
                  <Route path="/operation-logs" element={<ProtectedRoute><VehicleOperationLogManagement /></ProtectedRoute>} />
                  <Route path="/employees" element={<ProtectedRoute><EmployeeManagement /></ProtectedRoute>} />
                  <Route path="/departments" element={<ProtectedRoute><DepartmentManagement /></ProtectedRoute>} />
                  <Route path="/positions" element={<ProtectedRoute><PositionManagement /></ProtectedRoute>} />
                  <Route path="/formulas" element={<ProtectedRoute><FormulaManagement /></ProtectedRoute>} />
                  <Route path="/vendors" element={<ProtectedRoute><VendorManagement /></ProtectedRoute>} />
                  <Route path="/settings/wialon-credentials" element={<ProtectedRoute><CompanyWialonCredentialManagement /></ProtectedRoute>} />
                  <Route path="/settings/users" element={<ProtectedRoute><UserManagement /></ProtectedRoute>} />
                  <Route path="/settings/roles" element={<ProtectedRoute><RoleManagement /></ProtectedRoute>} />
                  <Route path="/settings/menus" element={<ProtectedRoute><MenuManagement /></ProtectedRoute>} />

                  {/* Payroll module */}
                  <Route path="/payroll/salary-history" element={<ProtectedRoute><SalaryHistoryManagement /></ProtectedRoute>} />
                  <Route path="/payroll/food-policy" element={<ProtectedRoute><FoodPolicyManagement /></ProtectedRoute>} />
                  <Route path="/payroll/periods" element={<ProtectedRoute><PayrollPeriodManagement /></ProtectedRoute>} />
                  <Route path="/payroll/attendance" element={<ProtectedRoute><AttendanceManagement /></ProtectedRoute>} />
                  <Route path="/payroll/attendance-report" element={<ProtectedRoute><AttendanceReport /></ProtectedRoute>} />
                  <Route path="/payroll/entries" element={<ProtectedRoute><PayrollEntryManagement /></ProtectedRoute>} />
                  <Route path="/payroll/report" element={<ProtectedRoute><PayslipReport /></ProtectedRoute>} />
                  <Route path="/payroll/worksheet" element={<ProtectedRoute><PayrollWorksheet /></ProtectedRoute>} />

                  {/* Vehicle Rental module */}
                  <Route path="/vehicles/rentals" element={<ProtectedRoute><RentalVehicleManagement /></ProtectedRoute>} />
                  <Route path="/vehicles/rental-attendance" element={<ProtectedRoute><RentalAttendanceManagement /></ProtectedRoute>} />
                  <Route path="/vehicles/rental-report" element={<ProtectedRoute><RentalExpenseReport /></ProtectedRoute>} />
                  <Route path="/vehicles/daily-kpi" element={<ProtectedRoute><DailyKpiManagement /></ProtectedRoute>} />
                  <Route path="/vehicles/expenses" element={<ProtectedRoute><VehicleExpenseManagement /></ProtectedRoute>} />
                  <Route path="/vehicles/financial-report" element={<ProtectedRoute><VehicleFinancialReport /></ProtectedRoute>} />

                  {/* Add other routes here */}
                </Routes>
              </AdminLayout>
            }
          />
        </Routes>
      </Router>
    </AuthProvider>
  );
}

// import { BrowserRouter, Routes, Route } from "react-router-dom";
// import AdminLayout from "../layouts/AdminLayout";

// import VehicleList from "../pages/VehicleList";
// import LiveTracking from "../pages/LiveTracking";
// import LoginPage from "./pages/LoginPage";

// function Dashboard() {
//   return <h2>Dashboard</h2>;
// }

// export default function App() {
//   return (
//     <BrowserRouter>
//       <AdminLayout>
//         <Routes>
//           <Route path="/" element={<Dashboard />} />
//           <Route path="/vehicles" element={<VehicleList />} />
//           <Route path="/tracking" element={<LiveTracking />} />
//         </Routes>
//       </AdminLayout>
//     </BrowserRouter>
//   );
// }