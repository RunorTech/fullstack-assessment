const ROLES = {
  admin: {
    permissions: ["products:create", "products:update"],
  },
  manager: {
    permissions: ["products:update"],
  },
};

/**
 * Express middleware to authenticate requests using a Bearer token.
 * Maps valid tokens to specific user roles (admin or manager).
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Authentication token is missing or malformed.",
    });
  }

  const token = authHeader.split(" ")[1];
  let role = null;

  if (token === process.env.ADMIN_TOKEN) {
    role = "admin";
  }

  if (!role) {
    return res.status(403).json({
      error: "Forbidden",
      message: "Invalid authentication token.",
    });
  }

  // Inject the authenticated user object with their role and permissions
  req.user = {
    role,
    permissions: ROLES[role].permissions,
  };

  next();
}

/**
 * Authorization middleware creator to restrict access based on permissions.
 */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user || !req.user.permissions.includes(permission)) {
      return res.status(403).json({
        error: "Forbidden",
        message: "You do not have permission to perform this action.",
      });
    }
    next();
  };
}

module.exports = {
  authMiddleware,
  requirePermission,
};
