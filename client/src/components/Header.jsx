import logo from "../assets/Logo.png";

function Header() {
  return (
    <div style={styles.container}>
      <img src={logo} alt="UPply logo" style={styles.logo} />
    </div>
  );
}

const styles = {
  container: {
      position: "absolute",
  top: "24px",
  left: "32px",
},
logo: {
  width: "85px",
  },
};

export default Header;