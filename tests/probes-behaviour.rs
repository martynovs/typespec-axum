//! What the probe contracts must DO, not only compile to: copied into the probes crate by tests/probes.sh.
use serde_json::{json, Value};

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
