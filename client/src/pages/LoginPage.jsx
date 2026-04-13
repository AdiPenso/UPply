import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Header from "../components/Header.jsx";
import { signIn, signOut, fetchAuthSession } from "aws-amplify/auth";
import { API_BASE_URL } from "../aws/config";

function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const navigate = useNavigate();

  const handleLogin = async () => {
    setErrorMessage("");
    setIsSubmitting(true);

    try {
      await signOut();

      await signIn({
        username: email,
        password,
      });

      const session = await fetchAuthSession();
      const userId = session?.tokens?.idToken?.payload?.sub;

      if (!userId) {
        throw new Error("Could not get user id from session.");
      }

    const response = await fetch(
  `${API_BASE_URL}/profile?user_id=${userId}`
);

      if (!response.ok) {
        throw new Error(`getUserProfile failed with status ${response.status}`);
      }

      const data = await response.json();

      if (data.exists) {
        navigate("/home");
      } else {
        navigate("/complete-profile");
      }
    } catch (error) {
      console.error("Login error:", error);

      const name = error?.name || "";
      const message = error?.message || "";

      if (name === "UserNotFoundException") {
        setErrorMessage("User does not exist.");
      } else if (name === "NotAuthorizedException") {
        setErrorMessage("Incorrect email or password.");
      } else if (name === "UserNotConfirmedException") {
        setErrorMessage("Please confirm your email before logging in.");
      } else {
        setErrorMessage(message || "Login failed.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div style={styles.page}>
      <Header />

      <div style={styles.card}>
        <h1 style={styles.title}>Login</h1>

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
          onClick={handleLogin}
          disabled={isSubmitting}
        >
          {isSubmitting ? "Logging in..." : "Login"}
        </button>

        <p style={styles.text}>
          Don&apos;t have an account?{" "}
          <Link to="/register" style={styles.link}>
            Register
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

export default LoginPage;