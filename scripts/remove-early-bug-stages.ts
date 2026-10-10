/**
 * One-off cleanup: workflows used to create their Bug fixing stage up front, so it
 * sat in the developer's list as "Waiting" before development was even done. It's
 * now created when QA first reports bugs. This removes the early ones that never
 * got any bugs, remembering their assignee as the project's bug fixer.
 *
 *   npm run cleanup:bug-stages            (preview: lists what would change)
 *   npm run cleanup:bug-stages -- --apply (makes the changes)
 */
import mongoose from "mongoose";
import { connectDatabase } from "../src/config/database";
import { Project, Task } from "../src/models";
import { recalcProjectStats } from "../src/services/project.service";

async function main() {
  const apply = process.argv.includes("--apply");
  await connectDatabase();
  const waiting = await Task.find({ stage: "BUG_FIXING", status: "WAITING" }).select("title project assignee").lean();
  let removed = 0;
  for (const stage of waiting) {
    // A stage QA already sent bugs to stays.
    if (await Task.exists({ parent: stage._id })) continue;
    console.log(`${apply ? "Removing" : "Would remove"}: ${stage.title}`);
    removed += 1;
    if (!apply) continue;
    await Project.updateOne({ _id: stage.project, bugFixer: null }, { bugFixer: stage.assignee ?? null });
    await Task.deleteOne({ _id: stage._id });
    await recalcProjectStats(stage.project);
  }
  console.log(removed ? `${removed} stage${removed === 1 ? "" : "s"} ${apply ? "removed" : "to remove. Run again with --apply to remove them"}.` : "Nothing to clean up.");
}

main()
  .then(() => mongoose.disconnect())
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await mongoose.disconnect();
    process.exit(1);
  });
