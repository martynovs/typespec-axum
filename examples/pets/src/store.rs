//! The pet store's handlers: an in-memory `Store`, and `Shop`, the node that serves each operation with one of its methods.
use crate::api::Refused;
use crate::api::petstore::{
    CreatePet, DeletePet, GetPet, ListPets, PetEvent, PetEvents, create_pet, delete_pet, get_pet,
    list_pets, pet_events,
};
use crate::types::{Failure, NewPet, Pet, PetId, PetPage};
use axum::Json;
use axum::http::{StatusCode, request::Parts};
use axum::response::{IntoResponse, sse::Event};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct Store {
    pets: Mutex<BTreeMap<String, Pet>>,
    issued: AtomicU64,
}

fn refusal(status: StatusCode, code: &str, message: String) -> Refused {
    Refused(
        (
            status,
            Json(Failure {
                code: code.to_owned(),
                message,
            }),
        )
            .into_response(),
    )
}

fn not_found(id: &str) -> Refused {
    refusal(StatusCode::NOT_FOUND, "not_found", format!("no pet {id:?}"))
}

fn text_of<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

impl Store {
    pub async fn list_pets(
        self: Arc<Self>,
        _parts: Parts,
        input: list_pets::Input,
    ) -> Result<list_pets::Answer, Refused> {
        let limit = match input.limit.as_deref().map(str::parse::<usize>) {
            Some(Ok(limit)) if (1..=100).contains(&limit) => limit,
            Some(_) => {
                return Err(refusal(
                    StatusCode::BAD_REQUEST,
                    "bad_limit",
                    "limit is 1 to 100".to_owned(),
                ));
            }
            None => 100,
        };
        let pets = self.pets.lock().expect("the pets lock");
        let pets = pets
            .values()
            .filter(|pet| {
                input
                    .species
                    .as_deref()
                    .is_none_or(|species| text_of(&pet.species) == species)
            })
            .filter(|pet| input.tag.iter().all(|tag| pet.tags.contains(tag)))
            .take(limit)
            .cloned()
            .collect();
        Ok(PetPage { pets, next: None })
    }

    pub async fn create_pet(
        self: Arc<Self>,
        _parts: Parts,
        input: create_pet::Input,
    ) -> Result<create_pet::Answer, Refused> {
        let NewPet {
            name,
            species,
            age,
            tags,
        } = input.body;
        if name.trim().is_empty() {
            return Err(refusal(
                StatusCode::UNPROCESSABLE_ENTITY,
                "blank_name",
                "a pet needs a name".to_owned(),
            ));
        }
        let id = format!("p{}", self.issued.fetch_add(1, Ordering::Relaxed) + 1);
        let pet = Pet {
            id: PetId(id.clone()),
            name,
            age,
            species,
            tags: tags.unwrap_or_default(),
        };
        self.pets
            .lock()
            .expect("the pets lock")
            .insert(id.clone(), pet.clone());
        Ok(create_pet::Answer {
            body: pet,
            location: format!("/pets/{id}"),
        })
    }

    pub async fn get_pet(
        self: Arc<Self>,
        _parts: Parts,
        input: get_pet::Input,
    ) -> Result<get_pet::Answer, Refused> {
        self.pets
            .lock()
            .expect("the pets lock")
            .get(&input.id)
            .cloned()
            .ok_or_else(|| not_found(&input.id))
    }

    pub async fn delete_pet(
        self: Arc<Self>,
        _parts: Parts,
        input: delete_pet::Input,
    ) -> Result<delete_pet::Answer, Refused> {
        self.pets
            .lock()
            .expect("the pets lock")
            .remove(&input.id)
            .map(drop)
            .ok_or_else(|| not_found(&input.id))
    }

    pub async fn pet_events(
        self: Arc<Self>,
        _parts: Parts,
        input: pet_events::Input,
    ) -> Result<pet_events::Answer, Refused> {
        let pet = self
            .pets
            .lock()
            .expect("the pets lock")
            .get(&input.id)
            .cloned()
            .ok_or_else(|| not_found(&input.id))?;
        let events = [
            Event::from(PetEvent::Changed(pet)),
            Event::from(PetEvent::Gone("end of the example feed".to_owned())),
        ];
        Ok(Box::pin(tokio_stream::iter(events.into_iter().map(Ok))))
    }
}

/// The node: the store, and for each operation of the contract the handler it serves it with.
#[derive(Default, Clone)]
pub struct Shop(pub Arc<Store>);

impl ListPets for Shop {
    fn list_pets_handler(&self) -> Option<list_pets::Call> {
        Some(list_pets::call_with_state(self.0.clone(), Store::list_pets))
    }
}

impl CreatePet for Shop {
    fn create_pet_handler(&self) -> Option<create_pet::Call> {
        Some(create_pet::call_with_state(
            self.0.clone(),
            Store::create_pet,
        ))
    }
}

impl GetPet for Shop {
    fn get_pet_handler(&self) -> Option<get_pet::Call> {
        Some(get_pet::call_with_state(self.0.clone(), Store::get_pet))
    }
}

impl DeletePet for Shop {
    fn delete_pet_handler(&self) -> Option<delete_pet::Call> {
        Some(delete_pet::call_with_state(
            self.0.clone(),
            Store::delete_pet,
        ))
    }
}

impl PetEvents for Shop {
    fn pet_events_handler(&self) -> Option<pet_events::Call> {
        Some(pet_events::call_with_state(
            self.0.clone(),
            Store::pet_events,
        ))
    }
}
