import logo from "../assets/Logo.png";
import { useNavigate } from "react-router-dom";

function OnboardingPage() {
  const navigate = useNavigate();

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <img src={logo} alt="UPply logo" style={styles.logo} />
        <h1 style={styles.tagline}>Find. Apply. Track.</h1>
        <button
          style={styles.button}
          onClick={() => navigate("/login")}
        >
          Start Searching
        </button>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
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
    padding: "48px 32px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    boxShadow: "0 10px 30px rgba(0,0,0,0.08)",
  },
  logo: {
    width: "260px",
    marginBottom: "32px",
    display: "block",
  },
  tagline: {
    fontSize: "32px",
    fontWeight: "700",
    lineHeight: "1.15",
    textAlign: "center",
    margin: "0 0 28px 0",
    color: "#111827",
  },
  button: {
    background: "#2f68e3",
    color: "white",
    border: "none",
    borderRadius: "12px",
    padding: "14px 28px",
    fontSize: "16px",
    fontWeight: "600",
    cursor: "pointer",
    boxShadow: "0 6px 18px rgba(37,99,235,0.25)",
  },
};

export default OnboardingPage;