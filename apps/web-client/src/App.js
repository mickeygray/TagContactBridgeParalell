import React, { useMemo, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { routeRegistry } from "./routeRegistry";
import { AuthContext } from "./auth";
import { LoginPage } from "./components/LoginPage";
import { ShellPage } from "./components/ShellPage";

const API_BASE_URL = "http://localhost:5001";

function PrivateRoute({ route }) {
  const auth = React.useContext(AuthContext);

  if (!auth.token) {
    return <Navigate to="/login" replace />;
  }

  if (route.requiredRole && auth.user?.role !== route.requiredRole) {
    return <Navigate to={auth.user?.audience === "admin" ? "/admin" : "/user"} replace />;
  }

  if (route.audience && auth.user?.audience !== route.audience) {
    return <Navigate to={auth.user?.audience === "admin" ? "/admin" : "/user"} replace />;
  }

  return <ShellPage route={route} />;
}

export default function App() {
  const [token, setToken] = useState(window.localStorage.getItem("parallel_token"));
  const [user, setUser] = useState(() => {
    const raw = window.localStorage.getItem("parallel_user");
    return raw ? JSON.parse(raw) : null;
  });

  const value = useMemo(
    () => ({
      token,
      user,
      async requestCode(email) {
        const response = await fetch(`${API_BASE_URL}/api/auth/send-code`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Could not send login code");
        }
        return data;
      },
      async login(email, code) {
        const response = await fetch(`${API_BASE_URL}/api/auth/verify-code`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, code }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Login failed");
        }
        window.localStorage.setItem("parallel_token", data.token);
        window.localStorage.setItem("parallel_user", JSON.stringify(data.user));
        setToken(data.token);
        setUser(data.user);
        return data.user;
      },
      async fetchJson(path) {
        const response = await fetch(`${API_BASE_URL}${path}`, {
          headers: token
            ? {
                Authorization: `Bearer ${token}`,
              }
            : {},
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Request failed");
        }
        return data;
      },
      logout() {
        window.localStorage.removeItem("parallel_token");
        window.localStorage.removeItem("parallel_user");
        setToken(null);
        setUser(null);
      },
    }),
    [token, user],
  );

  return (
    <AuthContext.Provider value={value}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {routeRegistry.map((route) => (
          <Route
            key={route.path}
            path={route.path}
            element={<PrivateRoute route={route} />}
          />
        ))}
        <Route
          path="/"
          element={<Navigate to={user?.audience === "admin" ? "/admin" : "/user"} replace />}
        />
      </Routes>
    </AuthContext.Provider>
  );
}
