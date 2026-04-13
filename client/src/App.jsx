import { BrowserRouter, Routes, Route } from "react-router-dom";
import OnboardingPage from "./pages/OnboardingPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ConfirmSignUpPage from "./pages/ConfirmSignUpPage";
import CompleteProfilePage from "./pages/CompleteProfilePage";

function App() {
  console.log("App loaded");
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<OnboardingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/confirm-signup" element={<ConfirmSignUpPage />} />
        <Route path="/complete-profile" element={<CompleteProfilePage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;