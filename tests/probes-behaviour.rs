//! What the probe contracts must DO, not only compile to: copied into the probes crate by tests/probes.sh.
use serde_json::json;
#[cfg(not(no_document))]
use serde_json::Value;

#[test]
fn merge_patch_of_an_optional_literal_is_still_checked() {
    use probes::merge_patch_literals::types::ItemMergePatchUpdate as Patch;
    for ok in [json!({}), json!({"size": "s"}), json!({"flavor": null}), json!({"flavor": "b"}), json!({"shape": "round"})] {
        assert!(serde_json::from_value::<Patch>(ok.clone()).is_ok(), "{ok}");
    }
    for bad in [json!({"size": "z"}), json!({"flavor": "z"}), json!({"shape": "square"})] {
        assert!(serde_json::from_value::<Patch>(bad.clone()).is_err(), "{bad}");
    }
}

#[cfg(not(no_document))]
#[test]
fn request_bodies_say_whether_they_are_required() {
    let documents = probes::documents();
    let (_, document) = documents.iter().find(|(name, _)| *name == "request_body_required").expect("the probe");
    let required = |path: &str| document["paths"][path]["post"]["requestBody"]["required"].as_bool().unwrap_or(false);
    assert!(!required("/a"), "an optional body is not required");
    assert!(required("/b"), "a body that may be null is still required");
    assert!(required("/c"));
}

#[test]
fn array_parameters_of_a_named_array_are_lists() {
    use probes::named_array_parameters::api::probe::get_q::Input;
    let input = Input { unknown: 0, g: vec!["11".to_owned()], e: vec!["7".to_owned(), "8".to_owned()], i: vec![] };
    assert_eq!((input.g.len(), input.e.len(), input.i.len()), (1, 2, 0));
}

#[cfg(not(no_document))]
#[test]
fn documents_hold_no_dangling_references() {
    fn references(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                if let Some(Value::String(r)) = map.get("$ref") {
                    out.push(r.clone());
                }
                map.values().for_each(|v| references(v, out));
            }
            Value::Array(items) => items.iter().for_each(|v| references(v, out)),
            _ => {}
        }
    }
    for (name, document) in probes::documents() {
        let mut found = Vec::new();
        references(&document, &mut found);
        for reference in found {
            let target = reference.trim_start_matches("#/components/schemas/");
            assert!(document["components"]["schemas"].get(target).is_some(), "{name}: {reference} is not a schema of its document");
        }
    }
}

#[test]
fn optional_nullable_unions_tell_absent_from_null() {
    use probes::merge_patch_nullable_unions::types::ItemMergePatchUpdate as Patch;
    for (body, again) in [
        (json!({}), json!({})),
        (json!({"v": null}), json!({"v": null})),
        (json!({"v": 3}), json!({"v": 3})),
        (json!({"m": null}), json!({"m": null})),
        (json!({"w": null}), json!({"w": null})),
    ] {
        let patch: Patch = serde_json::from_value(body.clone()).unwrap_or_else(|e| panic!("{body}: {e}"));
        assert_eq!(serde_json::to_value(&patch).expect("JSON"), again, "{body}");
    }
}

#[cfg(not(no_document))]
#[test]
fn every_document_has_each_operation_id_once() {
    fn ids(value: &Value, out: &mut Vec<String>) {
        if let Some(paths) = value["paths"].as_object() {
            for item in paths.values().filter_map(Value::as_object) {
                out.extend(item.values().filter_map(|op| op["operationId"].as_str().map(str::to_owned)));
            }
        }
    }
    for (name, document) in probes::documents() {
        let mut found = Vec::new();
        ids(&document, &mut found);
        let mut sorted = found.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), found.len(), "{name} repeats an operationId: {found:?}");
    }
}

#[test]
fn a_list_is_not_read_as_a_struct() {
    use probes::union_of_lists_and_structs::types::OneOrMany;
    for body in [json!([{"inner": {"v": "a"}}, {"other": {"v": "b"}}]), json!({"inner": {"v": "a"}}), json!([])] {
        let value: OneOrMany = serde_json::from_value(body.clone()).expect("a value");
        assert_eq!(serde_json::to_value(&value).expect("JSON"), body, "{body}");
    }
}

#[test]
fn a_required_nullable_field_has_to_be_there() {
    use probes::required_nullable_fields::types::{Either, Strict};
    assert!(serde_json::from_value::<Strict>(json!({"y": 1})).is_err(), "x is required, though it may be null");
    assert!(serde_json::from_value::<Strict>(json!({"x": null, "y": 1})).is_ok());
    // So a dictionary is not a page that has no list.
    let dict = json!({"k0": 1, "k1": 2});
    let either: Either = serde_json::from_value(dict.clone()).expect("a dict");
    assert_eq!(serde_json::to_value(&either).expect("JSON"), dict);
}

#[test]
fn a_nullable_union_of_a_nullable_union_keeps_null() {
    use probes::nested_nullable_unions::types::Holder;
    for body in [json!({"b": null, "d": 1}), json!({"c": null, "d": 1}), json!({"d": 1}), json!({"b": 2, "d": null})] {
        let holder: Holder = serde_json::from_value(body.clone()).unwrap_or_else(|e| panic!("{body}: {e}"));
        assert_eq!(serde_json::to_value(&holder).expect("JSON"), body, "{body}");
    }
}

#[test]
fn null_is_kept_by_a_recursive_nullable_union() {
    use probes::recursive_nullable_union::types::Holder;
    for body in [json!({"u": {"name": "a", "child": null}}), json!({"u": {"name": "a"}}), json!({"u": null}), json!({"u": {"name": "a", "child": "x"}})] {
        let holder: Holder = serde_json::from_value(body.clone()).unwrap_or_else(|e| panic!("{body}: {e}"));
        assert_eq!(serde_json::to_value(&holder).expect("JSON"), body, "{body}");
    }
}

#[test]
fn a_named_list_is_read_as_a_list_not_as_a_struct() {
    use probes::named_lists_in_unions::types::Holder;
    let body = json!({"a": ["x"], "b": ["y"]});
    let holder: Holder = serde_json::from_value(body.clone()).expect("a holder");
    assert_eq!(serde_json::to_value(&holder).expect("JSON"), body);
}

#[test]
fn unions_through_a_list_are_read_and_written() {
    use probes::unions_through_a_list::types::Req;
    let body = json!({"a": ["x", [1, ["y"]]], "b": ["x", [1, ["y"]]]});
    let req: Req = serde_json::from_value(body.clone()).expect("a request");
    assert_eq!(serde_json::to_value(&req).expect("JSON"), body);
}

#[test]
fn a_list_goes_to_the_variant_that_is_a_list() {
    use probes::lists_first_through_names::types::Req;
    for body in [json!({"l": [[], []], "w": [5]}), json!({"l": [{"a": 1}], "w": {"a": 2}}), json!({"l": [[{"a": 1}]], "w": [7, 8]})] {
        let req: Req = serde_json::from_value(body.clone()).unwrap_or_else(|e| panic!("{body}: {e}"));
        assert_eq!(serde_json::to_value(&req).expect("JSON"), body, "{body}");
    }
}

#[test]
fn template_unions_of_one_name_are_two_types() {
    use probes::template_unions_used_twice::types::Req;
    let body = json!({"a": 3, "b": true});
    let req: Req = serde_json::from_value(body.clone()).expect("a request");
    assert_eq!(serde_json::to_value(&req).expect("JSON"), body);
}

#[test]
fn nullable_union_map_values_keep_null() {
    use probes::nullable_union_map_values::types::H;
    let body = json!({"e": {"k": null, "j": {"n": "x"}}, "l": {"a": "a", "z": null}});
    let h: H = serde_json::from_value(body.clone()).expect("a value");
    assert_eq!(serde_json::to_value(&h).expect("JSON"), body);
}

#[test]
fn a_json_value_type_with_nullable_elements_round_trips() {
    use probes::recursive_json_union::types::Req;
    for j in [json!("s"), json!(1.5), json!(true), json!(["x", null, [2.5, [null, "y"]]]), json!({"k": null, "m": {"n": [true]}})] {
        let body = json!({"j": j});
        let req: Req = serde_json::from_value(body.clone()).unwrap_or_else(|e| panic!("{body}: {e}"));
        assert_eq!(serde_json::to_value(&req).expect("JSON"), body, "{body}");
    }
}

#[test]
fn nested_literal_unions_hold_their_values() {
    use probes::nested_literal_unions::types::Holder;
    let ok = json!({"a": "b", "b": null, "c": {"v": "d"}, "d": "c", "e": null});
    let holder: Holder = serde_json::from_value(ok.clone()).expect("a holder");
    assert_eq!(serde_json::to_value(&holder).expect("JSON"), ok);
    for bad in [json!({"a": "z", "c": {"v": "a"}, "d": "a"}), json!({"a": "a", "c": {"v": "z"}, "d": "a"}), json!({"a": "a", "c": {"v": "a"}, "d": "z"})] {
        assert!(serde_json::from_value::<Holder>(bad.clone()).is_err(), "{bad}");
    }
}

#[test]
fn a_union_that_holds_itself_beside_null_round_trips() {
    use probes::union_holding_itself_beside_null::types::Wrap;
    let body = json!({"e": [[], null, [[]]], "f": {"k": null, "j": {"z": null}}, "g": [null, []], "h": [[], null]});
    let wrap: Wrap = serde_json::from_value(body.clone()).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(serde_json::to_value(&wrap).expect("JSON"), body);
}

#[test]
fn a_named_literal_union_and_a_literal_are_checked_as_literals() {
    use probes::named_literal_union_plus_literal::types::{Any, Req};
    // The dog is told from the pet by its `kind`: "dog" is not one of a, b, x.
    let dog: Req = serde_json::from_value(json!({"v": {"name": "n", "kind": "dog", "k2": "a"}})).expect("a dog");
    assert!(matches!(dog.v, Any::Dog(_)), "{:?}", dog.v);
    let pet: Req = serde_json::from_value(json!({"v": {"name": "n", "kind": "b", "k2": "x"}})).expect("a pet");
    assert!(matches!(pet.v, Any::Pet(_)), "{:?}", pet.v);
    assert!(serde_json::from_value::<Req>(json!({"v": {"name": "n", "kind": "zzz", "k2": "x"}})).is_err());
    assert!(serde_json::from_value::<Req>(json!({"v": {"name": "n", "kind": "a", "k2": "zzz"}})).is_err());
}

#[test]
fn decimals_are_json_numbers_everywhere() {
    use probes::decimals::types::Item;
    let body = json!({"amount": 1.25, "nullable": null, "list": [1.5, 2.5], "by": {"k": 0.5}, "price": 9.75, "cheap": 2.5, "big": 100.5});
    let item: Item = serde_json::from_value(body.clone()).expect("an item");
    assert_eq!(serde_json::to_value(&item).expect("JSON"), body);
    assert!(serde_json::from_value::<Item>(json!({"amount": "1.25", "nullable": null, "list": [], "by": {}, "price": 1, "big": 1})).is_err(), "a string is not a number");
}

#[cfg(not(no_document))]
#[test]
fn a_decimal_is_a_number_in_the_document() {
    let documents = probes::documents();
    let (_, document) = documents.iter().find(|(name, _)| *name == "decimals").expect("the probe");
    assert_eq!(document["components"]["schemas"]["Decimal"], json!({"type": "number", "format": "decimal"}));
}

#[test]
fn cookie_parameters_are_inputs() {
    use probes::cookies::api::probe::get_c::Input;
    let input = Input { unknown: 0, session: Some("s".to_owned()), theme: None, x_visitor: None };
    assert_eq!(input.session.as_deref(), Some("s"));
}

#[test]
fn types_of_one_name_in_two_namespaces_are_two_types() {
    use probes::same_name_different_types::types::{DepotItem, Item, Out};
    let body = json!({"shop": {"sku": "s"}, "depot": {"bin": 3, "weight": 1.5}, "both": [{"bin": 1}]});
    let out: Out = serde_json::from_value(body.clone()).expect("a value");
    let _: &Item = &out.shop;
    let _: &DepotItem = &out.depot;
    assert_eq!(serde_json::to_value(&out).expect("JSON"), body);
    // They keep their own shapes.
    assert!(serde_json::from_value::<Out>(json!({"shop": {"bin": 3}, "depot": {"bin": 1}, "both": []})).is_err());
}

#[cfg(not(no_document))]
#[test]
fn types_of_one_name_in_two_services_are_two_types() {
    use probes::same_name_different_services::types::{Item, OtherItem};
    let _ = serde_json::from_value::<Item>(json!({"a": "x"})).expect("an item");
    let _ = serde_json::from_value::<OtherItem>(json!({"b": 1})).expect("another item");
    let documents = probes::documents();
    let schemas = |name: &str| {
        let (_, doc) = documents.iter().find(|(n, _)| *n == name).expect("a document");
        doc["components"]["schemas"].as_object().expect("schemas").keys().cloned().collect::<Vec<_>>()
    };
    assert_eq!(schemas("same_name_different_services"), ["Item"]);
}

#[test]
fn a_type_named_like_a_generated_helper_is_still_its_own_type() {
    use probes::user_type_named_like_a_helper::types::M;
    let body = json!({"a": {"k": null, "j": {"n": "x"}}, "b": {"x": 1}});
    let m: M = serde_json::from_value(body.clone()).expect("a value");
    assert_eq!(serde_json::to_value(&m).expect("JSON"), body);
}

#[test]
fn closed_model_refuses_a_property_it_does_not_list() {
    use probes::closed_model::types::{Closed, Open};
    assert!(serde_json::from_value::<Closed>(json!({"name": "a", "size": 1})).is_ok());
    assert!(serde_json::from_value::<Closed>(json!({"name": "a", "extra": 1})).is_err());
    // An open model drops it, as before.
    assert!(serde_json::from_value::<Open>(json!({"name": "a", "extra": 1})).is_ok());
}

#[cfg(no_document)]
#[test]
fn mapped_types_are_the_applications_own() {
    use probes::hand::{Bounds, Color, Limits, Minted};
    use probes::type_map::types::Item;
    // A mapped type is named by its path: the fields hold the application's types, so these assignments compile only if they are.
    let item: Item = serde_json::from_value(json!({
        "at": "2026-01-01T00:00:00Z", "color": "green", "limits": {"max": "9"}, "many": [{"min": "1"}],
        "by_name": {"a": {}}, "minted": "s", "note": "n"
    })).expect("an item");
    let _at: String = item.at.clone();
    let _color: Color = item.color;
    let limits: Limits = item.limits.clone();
    let _many: Vec<Limits> = item.many.clone();
    let _by_name: std::collections::BTreeMap<String, Limits> = item.by_name.clone();
    let _minted: Option<Option<Minted>> = item.minted.clone();
    let bounds: Option<Bounds> = item.bounds.clone();
    assert_eq!(limits.max.as_deref(), Some("9"));
    // An optional mapped field is a plain `Option`: left out and `null` are both `None`.
    assert_eq!(bounds, None);
    let with_null: Item = serde_json::from_value(json!({
        "at": "t", "color": "red", "bounds": null, "limits": {}, "many": [], "by_name": {}, "note": "n"
    })).expect("an item");
    assert_eq!(with_null.bounds, None);
    // The mapped type's own wire form is kept, and its `Debug` is its own.
    assert_eq!(serde_json::to_value(&item).expect("json")["limits"], json!({"max": "9", "min": null}));
    assert_eq!(format!("{:?}", Minted("hidden".to_owned())), "Minted(..)");
}

#[test]
fn extensions_become_constants_the_operation_reports() {
    use probes::extension_expr::api::probe::Operation;
    use probes::hand::{Demand, Guarding, Scope};
    assert_eq!(*Operation::OPEN.guarding(), Guarding::Unguarded);
    assert_eq!(*Operation::READ.guarding(), Guarding::Demand(Demand { scope: &[Scope::Read], binds: Some("account") }));
    assert_eq!(*Operation::MONEY.guarding(), Guarding::Demand(Demand { scope: &[Scope::Deposit, Scope::Withdraw], binds: None }));
    // The route still carries the raw extension.
    assert_eq!(Operation::OPEN.as_ref().extensions.len(), 1);
    // Every operation answers, so a table can be built from `ALL`.
    assert_eq!(Operation::ALL.iter().map(|op| op.guarding()).count(), 3);
}

#[tokio::test]
async fn unreadable_requests_are_refused_through_the_applications_function() {
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use probes::reject_with::api::probe::{list_400, list_401, list_422, list_none, ListNone, List400, List401, List422, mount};
    use tower::ServiceExt;

    struct Api;
    macro_rules! echo {
        ($trait:ident, $method:ident, $module:ident) => {
            impl $trait for Api {
                fn $method(&self) -> Option<$module::Call> {
                    Some($module::call(|_, input| async move { Ok(input.body) }))
                }
            }
        };
    }
    echo!(List400, list_400_handler, list_400);
    echo!(List422, list_422_handler, list_422);
    echo!(List401, list_401_handler, list_401);
    echo!(ListNone, list_none_handler, list_none);

    let app = mount(axum::Router::new(), &Api);
    let ask = |path: &'static str, body: &'static str| {
        let app = app.clone();
        async move {
            let request = Request::post(path).header("content-type", "application/json").body(Body::from(body)).expect("a request");
            let response = app.oneshot(request).await.expect("a response");
            let status = response.status();
            let text = String::from_utf8(to_bytes(response.into_body(), usize::MAX).await.expect("a body").to_vec()).expect("text");
            (status, text)
        }
    };
    // A body that does not decode: the first of 400, 422, 401 the operation lists; none listed keeps axum's own status.
    assert_eq!(ask("/a/x", "{").await, (StatusCode::BAD_REQUEST, "rejected 400: the request body does not match the API contract".to_owned()));
    assert_eq!(ask("/b", "{\"n\":\"x\"}").await.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(ask("/c", "{}").await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(ask("/d", "{}").await.0, StatusCode::UNPROCESSABLE_ENTITY);
    // Too deep a body, and a path that is not UTF-8, take the same status.
    let deep = Box::leak(format!("{}1{}", "[".repeat(40), "]".repeat(40)).into_boxed_str());
    assert_eq!(ask("/c", deep).await, (StatusCode::UNAUTHORIZED, "rejected 401: the request body nests deeper than this API accepts".to_owned()));
    assert_eq!(ask("/a/%FF", "{\"n\":1}").await, (StatusCode::BAD_REQUEST, "rejected 400: a path parameter is not valid UTF-8".to_owned()));
    // A body that is not JSON is 415 whatever the operation lists.
    let request = Request::post("/c").header("content-type", "text/plain").body(Body::from("{}")).expect("a request");
    let response = app.clone().oneshot(request).await.expect("a response");
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    // A query over the bound.
    let long = Box::leak(format!("/a/x?{}", "q=1&".repeat(100)).into_boxed_str());
    assert_eq!(ask(long, "{\"n\":1}").await.0, StatusCode::BAD_REQUEST);
}

/// Whether a type is `Eq`, told by the compiler: the inherent constant wins where its bound holds.
macro_rules! is_eq {
    ($ty:ty) => {{
        #[allow(dead_code)]
        trait NotEq {
            const IS: bool = false;
        }
        impl<T> NotEq for T {}
        struct Probe<T>(std::marker::PhantomData<T>);
        #[allow(dead_code)]
        impl<T: Eq> Probe<T> {
            const IS: bool = true;
        }
        Probe::<$ty>::IS
    }};
}

#[test]
fn types_derive_eq_when_every_part_is() {
    use probes::derive_eq::types::{Cycle, CycleB, Either, Floaty, HoldsFloat, HoldsPlain, Holds, Plain, Tree, WithFloat};
    assert!(is_eq!(Plain));
    assert!(is_eq!(HoldsPlain), "a map, a list, `unknown` and a nullable of Eq types");
    assert!(is_eq!(Tree), "a type that holds itself");
    assert!(is_eq!(Either));
    assert!(!is_eq!(WithFloat));
    assert!(!is_eq!(HoldsFloat), "made of a type with a float");
    assert!(!is_eq!(Floaty));
    assert!(!is_eq!(Holds), "made of a union with a float");
    assert!(!is_eq!(Cycle) && !is_eq!(CycleB), "a ring through a float");
}

#[cfg(no_document)]
#[test]
fn mapped_types_are_eq_when_their_entry_says_so() {
    use probes::type_map::types::{Item, Safe};
    assert!(is_eq!(Safe), "every mapped part says it is Eq");
    assert!(!is_eq!(Item), "Minted does not say so");
}

#[cfg(no_document)]
#[test]
fn template_instances_are_instances_of_one_generic_struct() {
    use probes::generic_struct::types::{Begun, Envelope, Held, Opts, Wrap};
    // One struct for every instance: these annotations compile only if `Envelope` and `Begun` take their arguments.
    let rows: Envelope<Vec<Held>> = serde_json::from_value(json!({"status": "ok", "data": [{"id": "a"}], "more": [[{"id": "b"}]]})).expect("rows");
    assert_eq!(rows.data.len(), 1);
    assert_eq!(rows.more.as_ref().map(Vec::len), Some(1));
    assert_eq!(rows.message, None, "left out is None");
    let none: Envelope<()> = serde_json::from_value(json!({"status": "ok", "data": null})).expect("no data");
    assert_eq!(serde_json::to_value(&none).expect("json"), json!({"status": "ok", "data": null}));
    assert!(serde_json::from_value::<Envelope<()>>(json!({"status": "ok"})).is_err(), "`data` is required");
    let begun: Envelope<Begun<Opts>> = serde_json::from_value(json!({"status": "ok", "data": {"ceremony": "c", "options": {"challenge": "x"}}})).expect("begun");
    assert_eq!(begun.data.options.challenge, "x");
    let wrap: Wrap<Held> = serde_json::from_value(json!({"items": [], "by_name": {"k": {"id": "a"}}})).expect("wrap");
    assert_eq!(wrap.by_name.len(), 1);
    assert_eq!(serde_json::to_value(Envelope::<i32> { status: "ok".into(), message: None, data: 3, filters: None, more: None }).expect("json"), json!({"status": "ok", "data": 3}));
    // The constants of the template are on every instance.
    assert_eq!(Envelope::<i32>::MORE_DESCRIPTION, "At most 3 rows.");
}

#[cfg(no_document)]
#[test]
fn generic_path_is_taken_only_for_instances_it_reads_as_the_contract_does() {
    use probes::generic_struct_edges::types::{Envelope, Held, Loop, Node, PageOfHeld, PatchOfHeld, Pet, RecordOfHeld};
    // A type that holds an instance of a generic struct holding it: boxed, or it would have no size.
    let node: Node = serde_json::from_value(json!({"id": "a", "next": {"status": "ok", "data": {"id": "b"}}})).expect("node");
    assert_eq!(node.next.as_ref().map(|e| e.data.id.as_str()), Some("b"));
    let looped: Loop<Held> = serde_json::from_value(json!({"data": {"id": "a"}, "other": {"data": "x"}})).expect("loop");
    assert_eq!(looped.other.as_ref().map(|l| l.data.as_str()), Some("x"));
    let _: Option<Envelope<Node>> = None;
    // `@withOptionalProperties` makes the instance's properties optional: its own struct says so.
    assert!(serde_json::from_value::<PatchOfHeld>(json!({})).is_ok());
    // A union of literals as an argument keeps its check, so a cat is not read as a tagged thing.
    assert!(matches!(serde_json::from_value::<Pet>(json!({"kind": "cat", "id": "1", "meow": "m"})), Ok(Pet::Cat(_))));
    assert!(serde_json::from_value::<Pet>(json!({"kind": "zzz", "id": "1"})).is_err());
    // A model of the contract named `Record` is a struct, not a map.
    let record: RecordOfHeld = serde_json::from_value(json!({"id": "r", "data": {"id": "h"}})).expect("record");
    assert_eq!(record.id, "r");
    // A template parameter named like a model of the contract is not a generic parameter.
    let page: PageOfHeld = serde_json::from_value(json!({"items": [{"id": "h"}], "total": 1})).expect("page");
    assert_eq!(page.total, 1);
}
