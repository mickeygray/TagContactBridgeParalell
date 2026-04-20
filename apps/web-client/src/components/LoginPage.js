import React, { useContext, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuthContext } from "../auth";

export function LoginPage() {
  const auth = useContext(AuthContext);
  const navigate = useNavigate();
  const [email, setEmail] = useState("mgray@taxadvocategroup.com");
  const [code, setCode] = useState("");
  const [previewCode, setPreviewCode] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [step, setStep] = useState("request");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function handleSendCode(event) {
    event.preventDefault();
    setError("");
    setMessage("");
    try {
      const result = await auth.requestCode(email);
      setPreviewCode(result.previewCode || "");
      setExpiresAt(result.expiresAt || "");
      setStep("verify");
      setMessage("Login code issued.");
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setMessage("");
    try {
      const user = await auth.login(email, code);
      navigate(user?.audience === "admin" ? "/admin" : "/user");
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <main className="page page-centered">
      <section className="panel auth-panel">
        <h1>Parallel Control Plane</h1>
        <p>OTP auth first pass for `3001` to `5001`.</p>
        <form onSubmit={step === "request" ? handleSendCode : handleSubmit} className="stack">
          <label>
            Email
            <input value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {step === "verify" ? (
            <label>
              Code
              <input value={code} onChange={(e) => setCode(e.target.value)} />
            </label>
          ) : null}
          <button type="submit">{step === "request" ? "Send code" : "Sign in"}</button>
        </form>
        {message ? <p>{message}</p> : null}
        {previewCode ? <p>Preview code: <strong>{previewCode}</strong></p> : null}
        {expiresAt ? <p>Expires: {new Date(expiresAt).toLocaleTimeString()}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </section>
    </main>
  );
}
