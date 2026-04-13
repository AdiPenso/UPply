const awsConfig = {
  Auth: {
    Cognito: {
      userPoolId: "us-east-1_uJS1eTvc4",
      userPoolClientId: "4e1r4srhusr2ahndcesi80freh",
      loginWith: {
        email: true,
      },
    },
  },
};

export const API_BASE_URL =
  "https://ujtgnne0r6.execute-api.us-east-1.amazonaws.com";

export default awsConfig;