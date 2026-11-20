import "@typespec/http";
import "@typespec/openapi";
using Http;
using OpenAPI;
@service namespace Probe;
model Event { name: string }
model Answer { text: string }
model Input { v: string }
model Call { v: string }
@route("/a") @get op state(): Answer;
@route("/b") @get op request(): Event;
@route("/c") @get op response(): Input;
@route("/d") @get op parts(): Call;
@route("/e") @get op route(): Answer;
@route("/f") @get op refused(): Answer;
@route("/g") @get op router(): Answer;
@route("/h") @get op method(): Answer;
@route("/i") @get op document(): Answer;
@route("/j") @get op mount(): Answer;
