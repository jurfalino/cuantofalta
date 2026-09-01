export interface Env {
  DB: D1Database
  OPERATOR_SECRET: string
  MP_CLIENT_ID: string
  MP_CLIENT_SECRET: string
  TOKEN_KEY: string
  PUBLIC_BASE_URL: string
  // Enables MP's sandbox OAuth (`test_token: true` on the code exchange),
  // required when connecting against Mercado Pago test users rather than
  // real seller accounts. String, not boolean, because Workers env vars
  // and .dev.vars are always strings — the literal value 'true' enables
  // it; anything else (including unset) leaves it off. Optional: absent in
  // production.
  MP_TEST_MODE?: string
}
