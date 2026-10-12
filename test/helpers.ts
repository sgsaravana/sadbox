import { db } from "../src/db";

/** Insert a bare project row (no VM) and return its id. */
export function makeProject(id: string, state = "running"): string {
  db.query("INSERT INTO projects (id, name, image, state, source_path) VALUES (?, ?, 'img', ?, '')")
    .run(id, `proj-${id}`, state);
  return id;
}
