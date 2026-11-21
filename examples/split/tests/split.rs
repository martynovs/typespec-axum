//! The three outputs fit together: the `web` and `rpc` contracts name the models of `common`, so a value is one type in both.
use split_example::common::types::{Item, NewItem};
use split_example::rpc::client::shop_rpc::{Api, follow, reserve, stock};
use split_example::rpc::irpc_api::shop_rpc::{Remote, spawn};
use std::future::Future;
use std::sync::Arc;
use tokio_stream::StreamExt;

/// The inside service, written once against the contract's `Api` and served over irpc.
struct Shop;

impl Api for Shop {
    fn reserve(
        &self,
        request: reserve::Request,
    ) -> impl Future<Output = Result<reserve::Answer, reserve::Error>> + Send {
        async move {
            Ok(Item {
                id: "i1".to_owned(),
                name: request.body.name,
                cents: request.body.cents,
            })
        }
    }
    fn stock(
        &self,
        request: stock::Request,
    ) -> impl Future<Output = Result<stock::Answer, stock::Error>> + Send {
        async move {
            match request.id.as_str() {
                "i1" => Ok(Item {
                    id: "i1".to_owned(),
                    name: "tea".to_owned(),
                    cents: 350,
                }),
                _ => Err(stock::Error::Refused(stock::Refusal::Status404(
                    split_example::rpc::types::Anon1 {
                        message: "no such item".to_owned(),
                    },
                ))),
            }
        }
    }
    fn follow(
        &self,
        _request: follow::Request,
    ) -> impl Future<Output = Result<follow::Answer, follow::Error>> + Send {
        async move {
            let item = Item {
                id: "i1".to_owned(),
                name: "tea".to_owned(),
                cents: 350,
            };
            let events: std::pin::Pin<Box<dyn tokio_stream::Stream<Item = Result<_, _>> + Send>> =
                Box::pin(tokio_stream::iter([Ok(
                    split_example::rpc::client::shop_rpc::StockEvent::Added(item),
                )]));
            Ok(events.into())
        }
    }
}

#[tokio::test]
async fn the_inside_service_is_called_over_irpc_with_the_shared_models() {
    let remote = Remote(spawn(Arc::new(Shop)));
    let item = remote
        .reserve(reserve::Request {
            body: NewItem {
                name: "tea".to_owned(),
                cents: 350,
            },
        })
        .await
        .expect("reserved");
    assert_eq!((item.id.as_str(), item.cents), ("i1", 350));
    let again: Item = remote
        .stock(stock::Request {
            id: "i1".to_owned(),
        })
        .await
        .expect("in stock");
    assert_eq!(again.name, "tea");
    assert!(matches!(
        remote.stock(stock::Request { id: "x".to_owned() }).await,
        Err(split_example::rpc::client::Error::Refused(
            stock::Refusal::Status404(_)
        ))
    ));
    let mut events = remote.follow(follow::Request {}).await.expect("a stream");
    assert!(
        matches!(events.next().await, Some(Ok(split_example::rpc::client::shop_rpc::StockEvent::Added(item))) if item.id == "i1")
    );
}

#[test]
fn the_web_contract_answers_with_the_shared_models_too() {
    // One type in both contracts: these compile only if the web answers are the models of `common`.
    let _: fn(split_example::web::api::shop_web::list_items::Answer) -> Vec<Item> = |answer| answer;
    let _: fn(split_example::web::api::shop_web::add_item::Input) -> NewItem = |input| input.body;
}
