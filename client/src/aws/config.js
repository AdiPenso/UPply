// AWS configuration for the client.
//
// Values are read from Vite environment variables at build time.
// Copy `client/.env.example` to `client/.env` and fill in the values from your
// AWS account. These identifiers (Cognito pool/client IDs, API Gateway URL) are
// shipped to the browser and are not secrets — they are kept out of source only
// so the repo isn't hard-wired to one AWS account.

const {
  VITE_COGNITO_USER_POOL_ID,
  VITE_COGNITO_USER_POOL_CLIENT_ID,
  VITE_API_BASE_URL,
} = import.meta.env;

if (
  !VITE_COGNITO_USER_POOL_ID ||
  !VITE_COGNITO_USER_POOL_CLIENT_ID ||
  !VITE_API_BASE_URL
) {
  throw new Error(
    "Missing AWS configuration. Copy client/.env.example to client/.env and fill in the values."
  );
}

const awsConfig = {
  Auth: {
    Cognito: {
      userPoolId: VITE_COGNITO_USER_POOL_ID,
      userPoolClientId: VITE_COGNITO_USER_POOL_CLIENT_ID,
      loginWith: {
        email: true,
      },
    },
  },
};

export const API_BASE_URL = VITE_API_BASE_URL;

export default awsConfig;
