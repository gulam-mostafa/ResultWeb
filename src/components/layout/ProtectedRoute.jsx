import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';

/**
 * ProtectedRoute — route-level role gate.
 *
 * @param {string[]} [allowedRoles] roles permitted to view the route; omit for "any signed-in user"
 */
export default function ProtectedRoute({ allowedRoles, children }) {
  const { isAuthenticated, role, user } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/" replace state={{ from: location.pathname }} />;
  }

  if (role === 'school_admin' && user?.status !== 'approved' && location.pathname !== '/pending-approval') {
    return <Navigate to="/pending-approval" replace />;
  }

  if (Array.isArray(allowedRoles) && allowedRoles.length > 0 && !allowedRoles.includes(role)) {
    // Send the user to a route they can actually use instead of a dead end.
    const fallback = role === 'student' ? '/my-result' : '/dashboard';
    return <Navigate to={fallback} replace />;
  }

  return children;
}
