import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchAuthSession } from "aws-amplify/auth";
import Header from "../components/Header.jsx";
import { createProfile } from "../services/api";

function CompleteProfilePage() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [location, setLocation] = useState("");

  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const navigate = useNavigate();

  const handleSubmit = async () => {
    setErrorMessage("");
    setIsSubmitting(true);

    try {
      const session = await fetchAuthSession();
      const userId = session.tokens.idToken.payload.sub;
      const email = session.tokens.idToken.payload.email;

      await createProfile({
        user_id: userId,
        email,
        first_name: firstName,
        last_name: lastName,
        phone,
        location,
      });

      navigate("/home");
    } catch (error) {
      console.error("Save profile error:", error);
      setErrorMessage("Could not save your profile. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div style={styles.page}>
      <Header />

      <div style={styles.card}>
        <h1 style={styles.title}>Complete Your Profile</h1>

        {errorMessage && <p style={styles.error}>{errorMessage}</p>}

        <input
          style={styles.input}
          type="text"
          placeholder="First Name"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
        />

        <input
          style={styles.input}
          type="text"
          placeholder="Last Name"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
        />

        <input
          style={styles.input}
          type="text"
          placeholder="Phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />

        <input
          style={styles.input}
          type="text"
          placeholder="Location (e.g. Tel Aviv, Israel)"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />

        <button
          style={styles.button}
          onClick={handleSubmit}
          disabled={isSubmitting}
        >
          {isSubmitting ? "Saving..." : "Save"}
        </button>
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

export default CompleteProfilePage;