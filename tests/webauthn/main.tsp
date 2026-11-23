import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Gateway;

model RelyingParty { name: string; id: string }
model User { id: string; name: string; displayName: string }
model PubKeyCredParams { type: "public-key"; alg: int32 }
model PublicKeyCredentialCreationOptions {
  rp: RelyingParty;
  user: User;
  challenge: string;
  pubKeyCredParams: PubKeyCredParams[];
  timeout?: uint32;
  attestation?: "none" | "indirect" | "direct" | "enterprise";
}
/** The options a browser creates a passkey with. */
model CreationChallengeResponse { publicKey: PublicKeyCredentialCreationOptions }

model AuthenticatorAttestationResponseRaw { attestationObject: string; clientDataJSON: string; transports?: ("usb" | "nfc" | "ble" | "internal" | "hybrid")[] }
/** What the browser made. */
model RegisterPublicKeyCredential { id: string; rawId: string; response: AuthenticatorAttestationResponseRaw; type: string }

model AllowCredentials { type: string; id: string }
model PublicKeyCredentialRequestOptions { challenge: string; timeout?: uint32; rpId: string; allowCredentials: AllowCredentials[]; userVerification: "required" | "preferred" | "discouraged" }
/** The options a browser signs in with. */
model RequestChallengeResponse { publicKey: PublicKeyCredentialRequestOptions; mediation?: "conditional" | "optional" | "required" | "silent" }

model AuthenticatorAssertionResponseRaw { authenticatorData: string; clientDataJSON: string; signature: string; userHandle?: string }
/** What the browser signed. */
model PublicKeyCredential { id: string; rawId: string; response: AuthenticatorAssertionResponseRaw; type: string }

model Account { id: string; passkeys: RegisterPublicKeyCredential[] }
model Failure { code: string }

@route("/passkey/v1") namespace Passkey {
  @route("/register/start") @post op register_start(@body body: Account): CreationChallengeResponse | { @statusCode _: 401; @body body: Failure };
  @route("/register/finish") @post op register_finish(@body body: RegisterPublicKeyCredential): Account | { @statusCode _: 401; @body body: Failure };
  @route("/login/start") @post op login_start(@body body: Account): RequestChallengeResponse;
  @route("/login/finish") @post op login_finish(@body body: PublicKeyCredential): Account | { @statusCode _: 401; @body body: Failure };
  @route("/credentials") @get op list_credentials(): RegisterPublicKeyCredential[];
}
