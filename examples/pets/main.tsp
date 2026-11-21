import "@typespec/http";
import "@typespec/openapi";
import "@typespec/openapi3";
import "@typespec/streams";
import "@typespec/sse";
import "@typespec/events";

using Http;
using OpenAPI;
using SSE;
using Events;

/** A small pet store: every kind of parameter, body and answer the emitter writes. */
@service(#{ title: "Pet store" })
@info(#{ version: "1.0.0" })
namespace PetStore;

/** The id of a pet, issued by the store. */
@minLength(1)
@maxLength(64)
scalar PetId extends string;

/** What a pet is. */
enum Species {
  /** Barks. */
  @summary("Woof")
  dog,

  /** Does not. */
  cat,
  bird,
}

/** How many pets there are of each species, by the species' names. */
model Census is Record<int32>;

/** A pet in the store. */
@example(#{ id: "p1", name: "Rex", species: Species.dog, tags: #["good"] })
model Pet {
  id: PetId;
  name: string;

  /** Absent while nobody knows. */
  age?: uint8;
  species: Species;
  tags: string[];

  /** What it cost, as a decimal number. */
  price?: decimal;
}

/** A pet that barks: everything a `Pet` is, and how loudly. */
model Dog extends Pet {
  loud: boolean;
}

/** What it takes to add a pet. */
model NewPet {
  @minLength(1) name: string;
  species: Species;
  age?: uint8;
  tags?: string[];
  price?: decimal;
}

/** One page of pets. */
model PetPage {
  pets: Pet[];

  /** Where the next page begins, absent on the last. */
  next?: string;
}

/** A kitten, told from a puppy by its `kind`. */
model Kitten {
  kind: "kitten";
  name: string;
}

/** A puppy, told from a kitten by its `kind`. */
model Puppy {
  kind: "puppy";
  name: string;
}

/** Either, which one the `kind` says. */
union Companion {
  kitten: Kitten,
  puppy: Puppy,
}

/** What to change about a pet: a field left out stays, one that is `null` is cleared. */
model PetPatch {
  note?: string | null;
  age?: uint8 | null;

  /** How it feels: one of two words, and may be cleared. */
  mood?: "happy" | "sad" | null;
}

/** What the request's cookies say. */
model Me {
  session?: string;
  theme?: string;
}

/** A note left with a pet. */
model Note {
  text: string;
}

/** Why a request was refused. */
model Failure {
  /** A stable word to branch on. */
  code: string;
  message: string;
}

@error
model NotFound {
  @statusCode _: 404;
  @body body: Failure;
}

@error
model Unprocessable {
  @statusCode _: 422;
  @body body: Failure;
}

/** What happens to a pet, as it happens. */
@events
union PetEvent {
  /** The pet as it is now. */
  changed: Pet,

  /** Why the feed ended, as text. */
  @contentType("text/plain")
  gone: string,
}

/** Pets of one species, or tagged with all of `tag`, a page at a time. */
@route("/pets")
@get
@tag("pets")
@summary("List pets.")
op list_pets(
  /** Only this species. */
  @query species?: Species,

  /** Only pets with every one of these tags. */
  @query(#{ explode: true }) tag?: string[],

  /** Only these ids, comma-separated (`ids=p1,p2`): an array that is not exploded. */
  @query ids?: PetId[],

  /** The most pets to answer. */
  @query @minValue(1) @maxValue(100) limit?: uint32,
): PetPage;

@route("/pets")
@post
@summary("Add a pet.")
op create_pet(@body pet: NewPet): {
  @statusCode _: 201;
  @header location: string;

  /** The name the pet was given, when it was changed on the way in. */
  @header("x-given-name") givenName?: string;
  @body body: Pet;
} | Unprocessable;

@route("/pets/{id}")
@get
@summary("Read one pet.")
op get_pet(@path id: PetId, @header("x-request-id") request_id?: string): Pet | NotFound;

/** The note is optional: a touch without one only marks the pet as seen. */
@route("/me")
@get
@summary("Read the cookies.")
op whoami(@cookie session?: string, @cookie theme?: string): Me;

#deprecated "Kept for old clients: read the pet instead."
@route("/pets/{id}/touch")
@post
@summary("Touch a pet.")
op touch_pet(@path id: PetId, @body note?: Note): Pet | NotFound;

/** Only an administrator may. The scope is for the server to enforce: the contract carries it, whatever it means. */
@route("/pets/{id}")
@delete
@tag("admin")
@extension("x-scope", "admin")
@summary("Remove a pet.")
op delete_pet(@path id: PetId): { @statusCode _: 204 } | NotFound;

@route("/pets/{id}/events")
@get
@summary("Follow one pet.")
op pet_events(@path id: PetId): SSEStream<PetEvent> | NotFound;
