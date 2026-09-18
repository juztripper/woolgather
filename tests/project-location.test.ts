import test from "node:test";
import assert from "node:assert/strict";
import {
  readProjectLocation,
  projectChatPath,
  projectViewPath,
} from "../apps/web/src/projects/projectLocation";

test("project entry is independent of the previously opened chat; explicit chat and legacy Plan links remain addressable", () => {
  assert.deepEqual(readProjectLocation(""), {
    view: "home",
    conversationId: "main",
  });
  assert.deepEqual(readProjectLocation("?chat=main"), {
    view: "overview",
    conversationId: "main",
  });
  assert.deepEqual(readProjectLocation("?chat=specialist&view=flow"), {
    view: "flow",
    conversationId: "specialist",
  });
  assert.deepEqual(readProjectLocation("?view=outline"), {
    view: "outline",
    conversationId: "main",
  });
  assert.equal(readProjectLocation("?view=unknown").view, "home");
});

test("project and chat destinations survive reopen and keep secondary views separate", () => {
  const chat = projectChatPath("project", "main", "?view=home&review=isolated");
  assert.equal(chat, "/projects/project?review=isolated&chat=main");
  assert.equal(readProjectLocation(chat.split("?")[1]).view, "overview");
  const home = projectViewPath("project", "home", "?chat=specialist&view=flow");
  assert.equal(home, "/projects/project");
  assert.equal(readProjectLocation("").view, "home");
  assert.equal(
    projectViewPath("project", "overview", "?chat=specialist&view=flow"),
    "/projects/project?chat=specialist",
  );
  assert.equal(
    projectViewPath("project", "overview", "?view=flow"),
    "/projects/project?chat=main",
  );
  assert.equal(
    projectChatPath("project", "specialist", "?view=references"),
    "/projects/project?chat=specialist",
  );
});
