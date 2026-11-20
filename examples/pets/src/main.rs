use axum::routing::get;
use axum::{Json, Router};
use pets_example::api::petstore;
use pets_example::store::Shop;

#[tokio::main]
async fn main() {
    let app = petstore::mount(Router::new(), &Shop::default()).route(
        "/openapi.json",
        get(|| async { Json(petstore::document()) }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000")
        .await
        .expect("bind 127.0.0.1:3000");
    println!("http://127.0.0.1:3000/pets  (document: /openapi.json)");
    axum::serve(listener, app).await.expect("serve");
}
