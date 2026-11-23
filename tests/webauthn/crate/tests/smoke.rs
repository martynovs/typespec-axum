//! The gateway's generated server, with the real `webauthn-rs-proto` types in its bodies and answers.
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;
use webauthn_probe::gateway::api::gateway::{
    passkey_list_credentials as list, passkey_login_finish as login_finish, passkey_login_start as login_start,
    passkey_register_finish as register_finish, passkey_register_start as register_start, mount, PasskeyListCredentials, PasskeyLoginFinish,
    PasskeyLoginStart, PasskeyRegisterFinish, PasskeyRegisterStart,
};
use webauthn_probe::gateway::types::Account;

fn creation() -> Value {
    json!({"publicKey": {"rp": {"name": "x", "id": "example.com"}, "user": {"id": "AQID", "name": "a", "displayName": "A"},
        "challenge": "AQID", "pubKeyCredParams": [{"type": "public-key", "alg": -7}], "timeout": 60000, "attestation": "none"}})
}
fn request() -> Value {
    json!({"publicKey": {"challenge": "AQID", "timeout": 60000, "rpId": "example.com",
        "allowCredentials": [{"type": "public-key", "id": "AQID"}], "userVerification": "preferred"}})
}
fn registration() -> Value {
    json!({"id": "AQID", "rawId": "AQID", "response": {"attestationObject": "AQID", "clientDataJSON": "AQID"}, "type": "public-key", "extensions": {}})
}
fn assertion() -> Value {
    json!({"id": "AQID", "rawId": "AQID", "response": {"authenticatorData": "AQID", "clientDataJSON": "AQID", "signature": "AQID", "userHandle": "AQID"},
        "type": "public-key", "extensions": {}})
}

struct Api;
impl PasskeyRegisterStart for Api {
    fn passkey_register_start_handler(&self) -> Option<register_start::Call> {
        Some(register_start::call(|_, _| async move { Ok(serde_json::from_value::<webauthn_rs_proto::CreationChallengeResponse>(creation()).expect("real type")) }))
    }
}
impl PasskeyRegisterFinish for Api {
    fn passkey_register_finish_handler(&self) -> Option<register_finish::Call> {
        // The body is the real type: its fields are the library's.
        Some(register_finish::call(|_, input| async move {
            let credential: webauthn_rs_proto::RegisterPublicKeyCredential = input.body;
            assert_eq!(credential.id, "AQID");
            Ok(Account { id: credential.id.clone(), passkeys: vec![credential] })
        }))
    }
}
impl PasskeyLoginStart for Api {
    fn passkey_login_start_handler(&self) -> Option<login_start::Call> {
        Some(login_start::call(|_, _| async move { Ok(serde_json::from_value::<webauthn_rs_proto::RequestChallengeResponse>(request()).expect("real type")) }))
    }
}
impl PasskeyLoginFinish for Api {
    fn passkey_login_finish_handler(&self) -> Option<login_finish::Call> {
        Some(login_finish::call(|_, input| async move {
            let credential: webauthn_rs_proto::PublicKeyCredential = input.body;
            Ok(Account { id: credential.id, passkeys: vec![] })
        }))
    }
}
impl PasskeyListCredentials for Api {
    fn passkey_list_credentials_handler(&self) -> Option<list::Call> {
        Some(list::call(|_, _| async move { Ok(vec![serde_json::from_value::<webauthn_rs_proto::RegisterPublicKeyCredential>(registration()).expect("real type")]) }))
    }
}

async fn send(method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let app = mount(axum::Router::new(), &Api);
    let request = Request::builder().method(method).uri(path).header("content-type", "application/json")
        .body(body.map_or_else(Body::empty, |v| Body::from(v.to_string()))).expect("a request");
    let response = app.oneshot(request).await.expect("a response");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.expect("a body");
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn the_real_types_travel_through_the_generated_server() {
    let (status, body) = send("POST", "/passkey/v1/register/start", Some(json!({"id": "a", "passkeys": []}))).await;
    assert_eq!((status, &body), (StatusCode::OK, &creation()));
    let (status, body) = send("POST", "/passkey/v1/register/finish", Some(registration())).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["passkeys"][0]["rawId"], "AQID");
    let (status, body) = send("POST", "/passkey/v1/login/start", Some(json!({"id": "a", "passkeys": []}))).await;
    assert_eq!((status, &body), (StatusCode::OK, &request()));
    let (status, body) = send("POST", "/passkey/v1/login/finish", Some(assertion())).await;
    assert_eq!((status, &body["id"]), (StatusCode::OK, &json!("AQID")));
    let (status, body) = send("GET", "/passkey/v1/credentials", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body[0]["id"], "AQID");
    // A body that is not the library's type is not read.
    let (status, _) = send("POST", "/passkey/v1/register/finish", Some(json!({"id": 1}))).await;
    assert_ne!(status, StatusCode::OK);
}

#[test]
fn the_document_describes_them_from_the_contract() {
    let document = webauthn_probe::gateway::api::gateway::document();
    let schemas = &document["components"]["schemas"];
    for name in ["CreationChallengeResponse", "RegisterPublicKeyCredential", "RequestChallengeResponse", "PublicKeyCredential"] {
        assert_eq!(schemas[name]["type"], "object", "{name}: {}", schemas[name]);
    }
    assert_eq!(schemas["CreationChallengeResponse"]["description"], "The options a browser creates a passkey with.");
    assert_eq!(schemas["CreationChallengeResponse"]["properties"]["publicKey"]["$ref"], "#/components/schemas/PublicKeyCredentialCreationOptions");
    // An emitted model: `derived` leaves a literal union to the derive (a string), `typespec` writes it to the letter.
    let attestation = &schemas["PublicKeyCredentialCreationOptions"]["properties"]["attestation"];
    assert!(attestation["enum"].is_null() || attestation["enum"] == json!(["none", "indirect", "direct", "enterprise"]), "{attestation}");
    assert_eq!(schemas["Account"]["properties"]["passkeys"]["items"]["$ref"], "#/components/schemas/RegisterPublicKeyCredential");
    let finish = &document["paths"]["/passkey/v1/register/finish"]["post"];
    assert_eq!(finish["requestBody"]["content"]["application/json"]["schema"]["$ref"], "#/components/schemas/RegisterPublicKeyCredential");
    let start = &document["paths"]["/passkey/v1/register/start"]["post"];
    assert_eq!(start["responses"]["200"]["content"]["application/json"]["schema"]["$ref"], "#/components/schemas/CreationChallengeResponse");
}
