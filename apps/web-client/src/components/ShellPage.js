import React, { useContext, useEffect, useState } from "react";
import { AuthContext } from "../auth";

const SERVICE_API_BASES = {
  inbound: "http://localhost:4001",
  outbound: "http://localhost:4002",
  ring: "http://localhost:6101",
};

export function ShellPage({ route }) {
  const auth = useContext(AuthContext);
  const [events, setEvents] = useState([]);
  const [services, setServices] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [workspace, setWorkspace] = useState(null);
  const [runtimeDefaults, setRuntimeDefaults] = useState(null);
  const [status, setStatus] = useState({ loading: true, error: "" });
  const [actionState, setActionState] = useState({ running: false, message: "", error: "" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setStatus({ loading: true, error: "" });
      try {
        const [serviceResponse, workspaceResponse] = await Promise.all([
          auth.fetchJson("/api/health/services"),
          auth.fetchJson("/api/auth/workspace"),
        ]);
        const nextServices = serviceResponse.services || [];
        const nextWorkspace = workspaceResponse.workspace || null;

        if (route.requiredRole === "admin") {
          const [eventResponse, accountResponse, defaultsResponse] = await Promise.all([
            auth.fetchJson("/api/events?limit=10"),
            auth.fetchJson("/api/auth/accounts"),
            auth.fetchJson("/api/auth/runtime-defaults"),
          ]);
          if (!cancelled) {
            setServices(nextServices);
            setWorkspace(nextWorkspace);
            setEvents(eventResponse.events || []);
            setAccounts(accountResponse.accounts || []);
            setRuntimeDefaults(defaultsResponse.defaults || null);
            setStatus({ loading: false, error: "" });
          }
          return;
        }

        if (!cancelled) {
          setServices(nextServices);
          setWorkspace(nextWorkspace);
          setAccounts([]);
          setRuntimeDefaults(null);
          setEvents([]);
          setStatus({ loading: false, error: "" });
        }
      } catch (error) {
        if (!cancelled) {
          setStatus({ loading: false, error: error.message });
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [auth, route.requiredRole]);

  async function reloadAdminData() {
    const [
      serviceResponse,
      eventResponse,
      accountResponse,
      workspaceResponse,
      defaultsResponse,
    ] = await Promise.all([
      auth.fetchJson("/api/health/services"),
      auth.fetchJson("/api/events?limit=10"),
      auth.fetchJson("/api/auth/accounts"),
      auth.fetchJson("/api/auth/workspace"),
      auth.fetchJson("/api/auth/runtime-defaults"),
    ]);
    setServices(serviceResponse.services || []);
    setEvents(eventResponse.events || []);
    setAccounts(accountResponse.accounts || []);
    setWorkspace(workspaceResponse.workspace || null);
    setRuntimeDefaults(defaultsResponse.defaults || null);
  }

  async function sendDemoEvent(kind) {
    setActionState({ running: true, message: "", error: "" });

    try {
      const eventId = `${kind}-${Date.now()}`;
      const payloads = {
        inbound: {
          leadId: eventId,
          source: "admin-shell",
          email: runtimeDefaults?.testEmail || "",
          phone: runtimeDefaults?.testPhone || "",
        },
        outbound: {
          messageId: eventId,
          destinationEmail: runtimeDefaults?.testEmail || "",
          destinationPhone: runtimeDefaults?.testPhone || "",
        },
        ring: {
          callId: eventId,
          userEmail: runtimeDefaults?.testEmail || "",
          destinationPhone: runtimeDefaults?.testPhone || "",
        },
      };

      const paths = {
        inbound: "/api/inbound/demo",
        outbound: "/api/outbound/demo",
        ring: "/api/ring/events",
      };

      const response = await fetch(`${SERVICE_API_BASES[kind]}${paths[kind]}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloads[kind]),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `Failed to create ${kind} event`);
      }

      await reloadAdminData();
      setActionState({
        running: false,
        message: `${kind} demo event queued: ${data.eventId}`,
        error: "",
      });
    } catch (error) {
      setActionState({ running: false, message: "", error: error.message });
    }
  }

  return (
    <main className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">{route.audience}</p>
          <h1>{route.title}</h1>
          <p>{route.description}</p>
        </div>
        <button onClick={auth.logout}>Logout</button>
      </header>

      <section className="grid">
        <article className="panel">
          <h2>Service health</h2>
          {status.loading ? <p>Loading service topology...</p> : null}
          {status.error ? <p className="error">{status.error}</p> : null}
          {!status.loading && !status.error ? (
            <ul className="plain-list">
              {services.map((service) => (
                <li key={service.name}>
                  <strong>{service.name}</strong> on <code>{service.port}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </article>
        <article className="panel">
          <h2>{route.requiredRole === "admin" ? "Recent events" : "Next feature slots"}</h2>
          {route.requiredRole === "admin" ? (
            <>
              <div className="button-row">
                <button disabled={actionState.running} onClick={() => sendDemoEvent("inbound")}>
                  Queue inbound
                </button>
                <button disabled={actionState.running} onClick={() => sendDemoEvent("outbound")}>
                  Queue outbound
                </button>
                <button disabled={actionState.running} onClick={() => sendDemoEvent("ring")}>
                  Queue ring
                </button>
              </div>
              {actionState.message ? <p>{actionState.message}</p> : null}
              {actionState.error ? <p className="error">{actionState.error}</p> : null}
              {status.loading ? (
                <p>Loading recent events...</p>
              ) : (
                <ul className="plain-list">
                  {events.map((event) => (
                    <li key={event._id}>
                      <strong>{event.eventType}</strong> {event.aggregateId} <code>{event.status}</code>
                    </li>
                  ))}
                  {events.length === 0 ? <li>No events yet.</li> : null}
                </ul>
              )}
            </>
          ) : (
            <p>
              Metrics dashboard, custom contact launching, lead contact history, and CX
              actions land here next.
            </p>
          )}
        </article>
        <article className="panel">
          <h2>{route.requiredRole === "admin" ? "Accounts" : "Your workspace"}</h2>
          {route.requiredRole === "admin" ? (
            <ul className="plain-list">
              {accounts.map((account) => (
                <li key={account.id}>
                  <strong>{account.name}</strong> {account.email} <code>{account.role}</code>
                </li>
              ))}
              {accounts.length === 0 ? <li>No accounts loaded.</li> : null}
            </ul>
          ) : workspace ? (
            <div className="stack compact-stack">
              <p>
                <strong>Workspace:</strong> {workspace.workspace}
              </p>
              <p>
                <strong>Station:</strong> {workspace.stationLabel || "Unassigned"}
              </p>
              <p>
                <strong>Capabilities:</strong>
              </p>
              <ul className="plain-list">
                {workspace.capabilities.map((capability) => (
                  <li key={capability}>
                    <code>{capability}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p>Loading workspace details...</p>
          )}
        </article>
      </section>
    </main>
  );
}
