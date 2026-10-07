import { Task } from "../models";
import { notify } from "../services/notification.service";
import { DONE_STATUSES } from "../types/domain";
import { logger } from "../utils/logger";

const HOUR = 60 * 60 * 1000;

/**
 * Notifies assignees of open tasks due within the next 24 hours, at most once
 * per task per 24 hours. Safe to run repeatedly and from several instances
 * (the reminder timestamp is claimed atomically per task).
 */
export async function runDeadlineReminders(now = new Date()): Promise<number> {
  const soon = new Date(now.getTime() + 24 * HOUR);
  const cutoff = new Date(now.getTime() - 24 * HOUR);
  const candidates = await Task.find({
    status: { $nin: [...DONE_STATUSES] },
    assignee: { $ne: null },
    dueDate: { $gte: now, $lte: soon },
    $or: [{ lastDeadlineReminderAt: null }, { lastDeadlineReminderAt: { $lt: cutoff } }],
  })
    .select("_id")
    .limit(1000)
    .lean();

  let sent = 0;
  for (const { _id } of candidates) {
    // Claim the task so concurrent runs don't double-notify.
    const task = await Task.findOneAndUpdate(
      { _id, $or: [{ lastDeadlineReminderAt: null }, { lastDeadlineReminderAt: { $lt: cutoff } }] },
      { lastDeadlineReminderAt: now },
      { returnDocument: "after" },
    )
      .select("title assignee dueDate")
      .lean();
    if (!task?.assignee) continue;
    await notify({
      recipients: [task.assignee],
      type: "DEADLINE_APPROACHING",
      title: `${task.title} is due ${task.dueDate ? `on ${task.dueDate.toISOString().slice(0, 10)}` : "soon"}`,
      entityType: "TASK",
      entityId: task._id,
    });
    sent += 1;
  }
  return sent + (await runQaDeadlineReminders(now));
}

/**
 * Notifies the QA of tasks waiting in QA whose QA deadline is within the next
 * 24 hours, with the same once-per-24-hours, claim-first rules as above.
 */
export async function runQaDeadlineReminders(now = new Date()): Promise<number> {
  const soon = new Date(now.getTime() + 24 * HOUR);
  const cutoff = new Date(now.getTime() - 24 * HOUR);
  const unclaimed = { $or: [{ lastQaReminderAt: null }, { lastQaReminderAt: { $lt: cutoff } }] };
  const candidates = await Task.find({ status: "IN_QA", qa: { $ne: null }, qaDueDate: { $gte: now, $lte: soon }, ...unclaimed })
    .select("_id")
    .limit(1000)
    .lean();

  let sent = 0;
  for (const { _id } of candidates) {
    const task = await Task.findOneAndUpdate({ _id, ...unclaimed }, { lastQaReminderAt: now }, { returnDocument: "after" })
      .select("title qa qaDueDate")
      .lean();
    if (!task?.qa) continue;
    await notify({
      recipients: [task.qa],
      type: "DEADLINE_APPROACHING",
      title: `QA on ${task.title} is due ${task.qaDueDate ? `on ${task.qaDueDate.toISOString().slice(0, 10)}` : "soon"}`,
      entityType: "TASK",
      entityId: task._id,
    });
    sent += 1;
  }
  return sent;
}

let timer: NodeJS.Timeout | null = null;

export function startJobs() {
  const tick = () =>
    runDeadlineReminders()
      .then((n) => n && logger.info("Deadline reminders sent", { count: n }))
      .catch((error: unknown) => logger.error("Deadline reminder job failed", { message: error instanceof Error ? error.message : String(error) }));
  timer = setInterval(tick, HOUR);
  timer.unref();
  void tick();
}

export function stopJobs() {
  if (timer) clearInterval(timer);
  timer = null;
}
