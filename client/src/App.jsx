import { BrowserRouter, Routes, Route } from "react-router-dom";
import OnboardingPage from "./pages/OnboardingPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ConfirmSignUpPage from "./pages/ConfirmSignUpPage";
import CompleteProfilePage from "./pages/CompleteProfilePage";
import HomePage from "./pages/HomePage";
import AccountPage from "./pages/AccountPage";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<OnboardingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/confirm-signup" element={<ConfirmSignUpPage />} />
        <Route path="/complete-profile" element={<CompleteProfilePage />} />
        <Route path="/home" element={<HomePage />} />
        <Route path="/account" element={<AccountPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;