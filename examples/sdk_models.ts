// The models that answer decisions.
import { Kai } from "@hanzo/kai";

const kai = new Kai();
for (const m of await kai.models.list()) console.log(m.id, m.owned_by, m.pricing);
