import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { confirmSignUp, resendSignUpCode } from "aws-amplify/auth";
import Header from "../components/Header.jsx";

function ConfirmSignUpPage() {
  const location = useLocation();
  const navigate = useNavigate();

  const [email, setEmail] = useState(location.state?.email || "");
  const [code, setCode] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResending, setIsResending] = useState(false);

  const handleConfirm = async () => {
    setErrorMessage("");
    setSuccessMessage("");
    setIsSubmitting(true);

    try {
      await confirmSignUp({
        username: email,
        confirmationCode: code,
      });

      setSuccessMessage("Account confirmed successfully. You can now log in.");

      setTimeout(() => {
        navigate("/login");
      }, 1200);
    } catch (error) {
      console.error("Confirm error:", error);

      const name = error?.name || "";
      const message = error?.message || "Confirmation failed";

      if (name === "CodeMismatchException") {
        setErrorMessage("The verification code is incorrect.");
      } else if (name === "ExpiredCodeException") {
        setErrorMessage("The verification code has expired. Please request a new one.");
      } else if (name === "NotAuthorizedException") {
        setErrorMessage("This account is already confirmed. You can log in.");
      } else if (name === "UserNotFoundException") {
        setErrorMessage("No user was found with this email.");
      } else if (name === "LimitExceededException") {
        setErrorMessage("Too many attempts. Please wait a moment and try again.");
      } else {
        setErrorMessage(message);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResendCode = async () => {
    setErrorMessage("");
    setSuccessMessage("");
    setIsResending(true);

    try {
      await resendSignUpCode({
        username: email,
      });

      setSuccessMessage("A new verification code was sent to your email.");
    } catch (error) {
      console.error("Resend code error:", error);

      const name = error?.name || "";
      const message = error?.message || "Could not resend code";

      if (name === "UserNotFoundException") {
        setErrorMessage("No user was found with this email.");
      } else if (name === "LimitExceededException") {
        setErrorMessage("Too many requests. Please wait a moment before trying again.");
      } else if (name === "NotAuthorizedException") {
        setErrorMessage("This account is already confirmed. You can log in.");
      } else {
        setErrorMessage(message);
      }
    } finally {
      setIsResending(false);
    }
  };

  return (
    <div style={styles.page}>
      <Header />

      <div style={styles.card}>
        <h1 style={styles.title}>Confirm Account</h1>

        {errorMessage && <p style={styles.error}>{errorMessage}</p>}
        {successMessage && <p style={styles.success}>{successMessage}</p>}

        <input
          style={styles.input}
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <input
          style={styles.input}
          type="text"
          placeholder="Verification Code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />

        <button
          style={styles.button}
          onClick={handleConfirm}
          disabled={isSubmitting}
        >
          {isSubmitting ? "Confirming..." : "Confirm Account"}
        </button>

        <button
          style={styles.secondaryButton}
          onClick={handleResendCode}
          disabled={isResending}
        >
          {isResending ? "Sending..." : "Resend Code"}
        </button>

        <p style={styles.text}>
          Already confirmed?{" "}
          <Link to="/login" style={styles.link}>
            Login
          </Link>
        </p>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    position: "relative",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    background: "#f3f4f6",
    padding: "24px",
  },
  card: {
    width: "100%",
    maxWidth: "420px",
    background: "#ffffff",
    borderRadius: "24px",
    padding: "40px 32px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    boxShadow: "0 10px 30px rgba(0,0,0,0.08)",
    marginTop: "20px",
  },
  title: {
    margin: 0,
    textAlign: "center",
    fontSize: "32px",
    color: "#111827",
  },
  input: {
    padding: "14px",
    fontSize: "16px",
    borderRadius: "12px",
    border: "1px solid #d1d5db",
    outline: "none",
  },
  button: {
    background: "#2f68e3",
    color: "white",
    border: "none",
    borderRadius: "12px",
    padding: "14px",
    fontSize: "18px",
    fontWeight: "600",
    cursor: "pointer",
    boxShadow: "0 6px 18px rgba(37,99,235,0.25)",
  },
  secondaryButton: {
    background: "#eef2ff",
    color: "#2f68e3",
    border: "1px solid #c7d2fe",
    borderRadius: "12px",
    padding: "14px",
    fontSize: "16px",
    fontWeight: "600",
    cursor: "pointer",
  },
  text: {
    margin: 0,
    textAlign: "center",
    color: "#4b5563",
    fontSize: "15px",
  },
  link: {
    color: "#2f68e3",
    textDecoration: "none",
    fontWeight: "600",
  },
  error: {
    margin: 0,
    color: "#b91c1c",
    background: "#fee2e2",
    border: "1px solid #fecaca",
    borderRadius: "12px",
    padding: "12px",
    fontSize: "14px",
    textAlign: "center",
  },
  success: {
    margin: 0,
    color: "#065f46",
    background: "#d1fae5",
    border: "1px solid #a7f3d0",
    borderRadius: "12px",
    padding: "12px",
    fontSize: "14px",
    textAlign: "center",
  },
};

export default ConfirmSignUpPage;