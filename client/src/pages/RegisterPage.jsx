import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { signUp } from "aws-amplify/auth";
import Header from "../components/Header.jsx";

function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const navigate = useNavigate();

  const handleRegister = async () => {
    setErrorMessage("");
    setIsSubmitting(true);

    try {
      const result = await signUp({
        username: email,
        password,
        options: {
          userAttributes: {
            email,
          },
        },
      });

      console.log("Sign up success:", result);
      
      navigate("/confirm-signup", {
        state: { email },
      });
    } catch (error) {
      console.error("Register error:", error);

      const name = error?.name || "";
      const message = error?.message || "Registration failed";

      if (name === "UsernameExistsException") {
        setErrorMessage("An account with this email already exists.");
      } else if (name === "InvalidPasswordException") {
        setErrorMessage("Password does not meet the required rules.");
      } else if (name === "InvalidParameterException") {
        setErrorMessage("Please check the details you entered.");
      } else {
        setErrorMessage(message);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div style={styles.page}>
      <Header />

      <div style={styles.card}>
        <h1 style={styles.title}>Register</h1>

        {errorMessage && <p style={styles.error}>{errorMessage}</p>}

        <input
          style={styles.input}
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <input
          style={styles.input}
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <button
          style={styles.button}
          onClick={handleRegister}
          disabled={isSubmitting}
        >
          {isSubmitting ? "Creating..." : "Create Account"}
        </button>

        <p style={styles.text}>
          Already have an account?{" "}
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
};

export default RegisterPage;