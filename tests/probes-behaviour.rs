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
    use probes::reject_with::api::probe::{list_400, list_401, list_422, list_none, list_text_and_401, list_text_400, list_bare_400_and_401, list_bare_400, ListNone, List400, List401, List422, ListTextAnd401, ListText400, ListBare400And401, ListBare400, mount};
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
    echo!(ListTextAnd401, list_text_and_401_handler, list_text_and_401);
    echo!(ListText400, list_text_400_handler, list_text_400);
    echo!(ListBare400And401, list_bare_400_and_401_handler, list_bare_400_and_401);
    echo!(ListBare400, list_bare_400_handler, list_bare_400);

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
    // A plain-text 400 or 413 is axum's answer to a body it cannot read, so it is not the status for one that does not decode: the JSON 401 is.
    assert_eq!(ask("/e", "{").await, (StatusCode::UNAUTHORIZED, "rejected 401: the request body does not match the API contract".to_owned()));
    // Only a plain-text 400: not a JSON refusal, so axum's own answer as well.
    let (status, text) = ask("/f", "{").await;
    assert!(status == StatusCode::BAD_REQUEST && !text.starts_with("rejected"), "{status} {text}");
    // A bare 400 declares no JSON answer: beside a JSON 401 the 401 is the status, alone it keeps axum's own answer.
    assert_eq!(ask("/g", "{").await, (StatusCode::UNAUTHORIZED, "rejected 401: the request body does not match the API contract".to_owned()));
    let (status, text) = ask("/h", "{").await;
    assert!(status == StatusCode::BAD_REQUEST && !text.starts_with("rejected"), "{status} {text}");
    // None listed: axum's own answer, not the application's function.
    let (status, text) = ask("/d", "{}").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(!text.starts_with("rejected"), "{text}");
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

#[test]
fn a_content_type_parameter_is_the_content_type_and_not_a_second_one() {
    use probes::request_media::client::probe::{patch_a, post_b};
    let body: probes::request_media::types::ItemMergePatchUpdate = serde_json::from_value(json!({})).expect("a patch");
    let given = patch_a::request("http://x", &patch_a::Request { content_type: Some("application/merge-patch+json".to_owned()), body: body.clone() }).expect("a request");
    assert_eq!(given.headers().get_all("content-type").iter().count(), 1);
    // Left out, the contract's own media type is sent.
    let left_out = patch_a::request("http://x", &patch_a::Request { content_type: None, body }).expect("a request");
    assert_eq!(left_out.headers()["content-type"], "application/merge-patch+json");
    let plain = post_b::request("http://x", &post_b::Request { content_type: None, body: serde_json::from_value(json!({})).expect("an item") }).expect("a request");
    assert_eq!(plain.headers().get_all("content-type").iter().count(), 1);
}

#[test]
fn a_cookie_a_cookie_header_cannot_carry_is_refused_and_dots_are_not_navigation() {
    use probes::cookies::client::probe::get_c;
    let bad = get_c::request("http://x", &get_c::Request { session: Some("a;b".to_owned()), theme: None, x_visitor: None });
    assert!(matches!(bad, Err(probes::cookies::client::Error::Request(_))));
    let ok = get_c::request("http://x", &get_c::Request { session: Some("abc".to_owned()), theme: None, x_visitor: None }).expect("a request");
    assert_eq!(ok.headers()["cookie"], "session=abc");
}

#[tokio::test]
async fn the_default_reqwest_transport_returns_a_redirect_as_the_answer() {
    use axum::http::{StatusCode, header};
    use axum::routing::get;
    use probes::client_reqwest::client::Reqwest;
    use probes::client_reqwest::client::probe::{Client, go};
    let app = axum::Router::new()
        .route("/go", get(|| async { (StatusCode::FOUND, [(header::LOCATION, "/elsewhere")]) }))
        .route("/elsewhere", get(|| async { axum::Json(json!({"v": "followed"})) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("a port");
    let address = listener.local_addr().expect("an address");
    tokio::spawn(async move { axum::serve(listener, app).await });
    let client = Client::new(Reqwest::default(), format!("http://{address}"));
    match client.go(go::Request {}).await {
        Ok(go::Answer::Found(found)) => assert_eq!(found.location, "/elsewhere"),
        other => panic!("{other:?}"),
    }
}

#[cfg(not(no_document))]
#[test]
fn types_the_application_writes_are_schemas_of_the_document_through_their_own_to_schema() {
    let documents = probes::documents();
    let (_, document) = documents.iter().find(|(name, _)| *name == "type_map").expect("the type-map probe has a document");
    let schemas = document["components"]["schemas"].as_object().expect("schemas");
    for name in ["Limits", "Bounds", "Color", "Minted"] {
        assert!(schemas.contains_key(name), "{name} is a component: {:?}", schemas.keys().collect::<Vec<_>>());
    }
    // The emitter writes no type for a mapped name, so what the document says of it is the application's.
    assert_eq!(schemas["Limits"]["type"], "object");
}

#[test]
fn a_mapped_model_in_a_union_is_a_variant_named_by_its_type_not_its_path() {
    use probes::type_map_direct_and_in_unions::types::Either;
    let either = Either::Limits(probes::hand::Limits::default());
    assert!(matches!(either, Either::Limits(_)));
}

#[cfg(not(no_document))]
#[test]
fn a_mapped_model_used_directly_and_one_with_no_named_schema_are_in_the_document() {
    let documents = probes::documents();
    let (_, document) = documents.iter().find(|(name, _)| *name == "type_map_direct_and_in_unions").expect("a document");
    assert!(document["components"]["schemas"].as_object().expect("schemas").contains_key("Limits"));
    // A declared mapped model nothing reaches is listed, and a mapped `std` type used as a body is written in place, with no component.
    assert!(document["components"]["schemas"].as_object().expect("schemas").contains_key("Unused"));
    // `inline` writes a type that has no `ToSchema` in place: no component, and the schema is its own.
    assert!(document["components"]["schemas"]["Holder"]["properties"]["nullable"].to_string().contains("null"), "a nullable inline field says null: {}", document["components"]["schemas"]["Holder"]["properties"]["nullable"]);
    assert!(!document["components"]["schemas"].as_object().expect("schemas").contains_key("Opaque"));
    assert_eq!(document["components"]["schemas"]["Holder"]["properties"]["token"]["description"], "The access token.");
    // A mapped scalar of another namespace that only a parameter names is a component all the same.
    assert!(document["components"]["schemas"].as_object().expect("schemas").contains_key("Money"));
    assert_eq!(document["paths"]["/s"]["post"]["requestBody"]["content"]["application/json"]["schema"]["type"], "string");
    assert_eq!(document["paths"]["/d"]["post"]["requestBody"]["content"]["application/json"]["schema"]["$ref"], "#/components/schemas/Limits");
}

#[cfg(not(no_document))]
#[test]
fn a_type_with_no_trait_of_utoipa_has_the_contracts_schema() {
    let documents = probes::documents();
    let (_, document) = documents.iter().find(|(name, _)| *name == "type_map_contract").expect("a document");
    let schemas = &document["components"]["schemas"];
    // The schema is the contract's model, under the name of the application's type.
    let challenge = &schemas["Challenge"];
    assert_eq!(challenge["type"], "object", "{challenge}");
    assert_eq!(challenge["description"], "The challenge the server gives.");
    assert_eq!(challenge["required"], serde_json::json!(["id", "challenge", "kind"]), "an inherited property is in it: {challenge}");
    assert_eq!(challenge["properties"]["rp_id"]["default"], "example.com");
    assert_eq!(challenge["properties"]["rp_id"]["examples"], serde_json::json!(["rp.example.com"]));
    assert_eq!(challenge["properties"]["old"]["deprecated"], true);
    assert_eq!(challenge["properties"]["challenge"]["minLength"], 4);
    assert_eq!(challenge["properties"]["challenge"]["description"], "The bytes, base64.");
    assert_eq!(challenge["properties"]["kind"]["enum"], serde_json::json!(["public-key"]));
    assert_eq!(challenge["properties"]["attachment"]["enum"], serde_json::json!(["platform", "cross-platform"]));
    assert_eq!(challenge["properties"]["flag"]["enum"], serde_json::json!([true]));
    assert_eq!(challenge["properties"]["transports"]["items"]["$ref"], "#/components/schemas/Transport");
    assert_eq!(schemas["Transport"]["enum"], serde_json::json!(["usb", "nfc"]));
    // Wherever utoipa asks a type: a body, an answer, a list, a parameter, a field, and a union.
    let reference = serde_json::json!("#/components/schemas/Challenge");
    assert_eq!(document["paths"]["/c"]["post"]["requestBody"]["content"]["application/json"]["schema"]["$ref"], reference);
    assert_eq!(document["paths"]["/c"]["post"]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"], reference);
    let list = &document["paths"]["/l"]["get"]["responses"]["200"]["content"]["application/json"]["schema"];
    assert_eq!(list["type"], "array");
    assert_eq!(list["items"]["required"], serde_json::json!(["id", "challenge", "kind"]), "{list}");
    let holder = &schemas["Holder"]["properties"];
    assert_eq!(holder["challenge"]["$ref"], reference, "{}", schemas["Holder"]);
    assert_eq!(holder["many"]["items"]["$ref"], reference);
}

#[cfg(not(no_document))]
#[test]
fn a_type_of_another_crate_is_in_the_document_of_each_service_that_shares_it() {
    use probes::type_map_contract_shared::api::{admin, probe};
    for (name, document) in [("Probe", probe::document()), ("Admin", admin::document())] {
        let schemas = &document["components"]["schemas"];
        assert_eq!(schemas["Challenge"]["required"], serde_json::json!(["challenge", "kind"]), "{name}: {schemas}");
        let schema = &document["paths"]["/challenge"]["post"]["requestBody"]["content"]["application/json"]["schema"];
        assert_eq!(schema["$ref"], "#/components/schemas/Challenge", "{name}");
    }
    // Only the service that has the operation says what it answers.
    let admin = admin::document();
    assert_eq!(admin["paths"]["/own"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]["type"], "array");
}

#[test]
fn a_template_is_one_generic_struct_whatever_the_document() {
    use probes::generic_template_with_a_document::types::{Envelope, Holder, Page, Pet};
    // One struct for every instance, as it is with no document: the application names `Envelope<T>` once.
    let one: Envelope<Pet> = serde_json::from_str(r#"{"status":"ok","data":{"name":"a"}}"#).expect("an envelope of a pet");
    assert_eq!(one.data.name, "a");
    let many: Envelope<Vec<Pet>> = serde_json::from_str(r#"{"status":"ok","data":[{"name":"a"},{"name":"b"}]}"#).expect("an envelope of pets");
    assert_eq!(many.data.len(), 2);
    let holder = Holder { pets: one, many: vec![many], maybe: Some(Envelope { status: "ok".to_owned(), data: Page { items: vec![], next: None }, message: None, problem: None }) };
    assert_eq!(serde_json::to_value(&holder).expect("json")["pets"]["data"]["name"], "a");
}

#[cfg(not(no_document))]
#[test]
fn an_instance_of_a_template_is_written_in_place_in_the_document() {
    let documents = probes::documents();
    let (_, document) = documents.iter().find(|(name, _)| *name == "generic_template_with_a_document").expect("a document");
    // The answer is the instance written out, as `@typespec/openapi3` has it: no `$ref` to a component of the instance.
    let answer = &document["paths"]["/p"]["get"]["responses"]["200"]["content"]["application/json"]["schema"];
    assert_eq!(answer["properties"]["data"]["$ref"], "#/components/schemas/Pet", "{answer}");
    assert_eq!(answer["required"], serde_json::json!(["status", "data"]));
    assert_eq!(answer["description"], "What every answer is.");
    // So is the body of a request.
    let body = &document["paths"]["/c"]["post"]["requestBody"]["content"]["application/json"]["schema"];
    assert_eq!(body["properties"]["data"]["$ref"], "#/components/schemas/Page", "{body}");
}

#[cfg(not(no_document))]
#[test]
fn a_type_only_a_generic_struct_names_keeps_its_schema() {
    let documents = probes::documents();
    let (_, document) = documents.iter().find(|(name, _)| *name == "generic_template_with_a_document").expect("a document");
    // `Problem` is first reached from a field of the generic struct, and is an ordinary type: its constraint is in its schema.
    assert_eq!(document["components"]["schemas"]["Problem"]["properties"]["code"]["minLength"], 3, "{}", document["components"]["schemas"]["Problem"]);
}

#[cfg(not(no_document))]
#[test]
fn two_instances_of_one_rust_spelling_each_keep_their_schema() {
    let documents = probes::documents();
    let (_, document) = documents.iter().find(|(name, _)| *name == "generic_template_with_a_document").expect("a document");
    let data = |path: &str| document["paths"][path]["get"]["responses"]["200"]["content"]["application/json"]["schema"]["properties"]["data"].clone();
    // `Envelope<string>` and `Envelope<utcDateTime>` are both `Envelope<String>` in Rust: the second is a struct of its own, and each is served whole.
    for path in ["/s", "/u"] {
        let answer = &document["paths"][path]["get"]["responses"]["200"]["content"]["application/json"]["schema"];
        assert_eq!(answer["required"], serde_json::json!(["status", "data"]), "{path}: {answer}");
        assert_eq!(data(path)["type"], "string", "{path}");
    }
}

#[cfg(not(no_document))]
#[test]
fn a_template_that_holds_itself_or_is_held_by_its_own_argument_ends() {
    let documents = probes::documents();
    let (_, document) = documents.iter().find(|(name, _)| *name == "generic_struct_edges").expect("a document");
    let schemas = &document["components"]["schemas"];
    // `Node { next?: Envelope<Node> }`: the instance is a component the field refers to, and its schema refers back to `Node`.
    assert_eq!(schemas["Node"]["properties"]["next"]["$ref"], "#/components/schemas/EnvelopeOfNode", "{}", schemas["Node"]);
    assert_eq!(schemas["EnvelopeOfNode"]["properties"]["data"]["$ref"], "#/components/schemas/Node");
    // `Loop<T> { other?: Loop<string> }`: the answer is written in place, and `Loop<string>` refers to its own component.
    let answer = &document["paths"]["/l"]["get"]["responses"]["200"]["content"]["application/json"]["schema"];
    assert_eq!(answer["properties"]["data"]["$ref"], "#/components/schemas/Held", "{answer}");
    assert_eq!(schemas["LoopOfstring"]["properties"]["other"]["$ref"], "#/components/schemas/LoopOfstring", "{}", schemas["LoopOfstring"]);
}

#[cfg(not(no_document))]
#[test]
fn a_scalar_the_application_writes_as_a_string_keeps_its_component() {
    let documents = probes::documents();
    let (_, document) = documents.iter().find(|(name, _)| *name == "type_map_scalar_schema").expect("a document");
    let schemas = &document["components"]["schemas"];
    // The component is the scalar's, with its doc: in every document mode.
    assert_eq!(schemas["Instant"]["type"], "string", "{}", schemas["Instant"]);
    assert_eq!(schemas["Instant"]["description"], "An instant on the wire.");
    // The fields refer to it where the document is written to the letter.
    let row = &schemas["Row"]["properties"];
    if row["at"]["$ref"].is_null() {
        // `derived` leaves a field to the derive: a string.
        assert_eq!(row["at"]["type"], "string");
    } else {
        assert_eq!(row["at"]["$ref"], "#/components/schemas/Instant");
        assert_eq!(row["maybe"]["anyOf"][0]["$ref"], "#/components/schemas/Instant", "{}", row["maybe"]);
        assert_eq!(row["maybe"]["anyOf"][1]["type"], "null");
        assert_eq!(row["many"]["items"]["$ref"], "#/components/schemas/Instant", "{}", row["many"]);
        assert_eq!(row["plain"]["type"], "string");
    }
}

#[cfg(not(no_document))]
#[test]
fn an_unsigned_parameter_has_its_format_where_it_is_and_on_its_items() {
    let documents = probes::documents();
    let (_, document) = documents.iter().find(|(name, _)| *name == "type_map_scalar_schema").expect("a document");
    let parameters = document["paths"]["/r"]["get"]["parameters"].as_array().expect("parameters");
    let find = |location: &str, name: &str| parameters.iter().find(|p| p["in"] == location && p["name"] == name).expect("a parameter").clone();
    // Only in a document written to the letter: `derived` leaves a parameter to utoipa.
    if find("query", "count")["schema"]["format"] == "uint32" {
        assert_eq!(find("query", "ids")["schema"]["items"]["format"], "uint32", "{}", find("query", "ids"));
        assert!(find("query", "ids")["schema"]["format"].is_null(), "the format is the items', not the list's");
        assert!(find("header", "x-count")["schema"]["format"].is_null(), "a string header has no unsigned format");
    }
}

#[cfg(not(no_document))]
#[test]
fn a_type_only_a_nullable_field_names_is_a_component() {
    let documents = probes::documents();
    let (_, document) = documents.iter().find(|(name, _)| *name == "nullable_global_type").expect("a document");
    // `Far` is declared outside every namespace and reached through a field the document writes by hand: it is still a component.
    assert_eq!(document["components"]["schemas"]["Far"]["properties"]["a"]["type"], "string", "{}", document["components"]["schemas"]);
    // And the fields refer to it: a reference beside null, and the items of a list beside null.
    let holder = &document["components"]["schemas"]["Holder"]["properties"];
    let text = holder.to_string();
    assert!(text.contains("#/components/schemas/Far"), "{holder}");
    assert!(holder["far"].to_string().contains("null") && holder["fars"].to_string().contains("null"), "{holder}");
}
