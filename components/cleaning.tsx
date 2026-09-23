"use client";
import { useState } from "react";
import {
  Plus,
  Clock,
  Info,
  UserRound,
  Camera,
  Check,
  ArrowRight,
  KeyRound,
} from "lucide-react";
import { useWorkspace, MutationForm } from "./workspace";
import { cleaningStates } from "@/lib/domain";
import { api, label, dateTime } from "@/lib/client";
import type { Task } from "@/lib/types";
import { Head, Button, Badge, Empty, Field, ErrorBox } from "./ui";
export function CleaningView() {
  const { data, show } = useWorkspace();
  const [filter, setFilter] = useState("all");
  const tasks = data.tasks.filter(
    (t) => filter === "all" || t.listingId === filter,
  );
  return (
    <>
      <Head
        title="Great stays start behind the scenes."
        description="From a first assignment to the final photo. Every handoff, accounted for."
      >
        <Button onClick={() => show("Add a cleaner", <CleanerForm />)}>
          <UserRound size={16} />
          Add cleaner
        </Button>
        <Button
          primary
          disabled={!data.listings.length}
          onClick={() => show("Schedule a task", <TaskForm />)}
        >
          <Plus size={16} />
          Create task
        </Button>
      </Head>
      <div className="calendar-toolbar">
        <select
          aria-label="Filter cleaning by property"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All properties</option>
          {data.listings.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <p className="muted">
          {tasks.filter((t) => t.status === "VERIFIED").length} verified ·{" "}
          {tasks.length} tasks in the next 90 days and previous 30 days
        </p>
      </div>
      {!tasks.length ? (
        <section className="panel">
          <Empty
            title="A fresh start for every stay."
            detail="Turnover tasks appear after a confirmed booking when cleaning automation is enabled. You can also schedule a task yourself."
          />
        </section>
      ) : (
        <div className="kanban" aria-label="Cleaning workflow">
          {cleaningStates.map((state) => (
            <section className="kanban-column" key={state}>
              <header>
                <h2>{label(state)}</h2>
                <span>{tasks.filter((t) => t.status === state).length}</span>
              </header>
              {tasks
                .filter((t) => t.status === state)
                .map((t) => (
                  <TaskCard key={t.id} task={t} />
                ))}
              {!tasks.some((t) => t.status === state) && (
                <p className="column-empty">Nothing here yet.</p>
              )}
            </section>
          ))}
        </div>
      )}
      <div className="calendar-note">
        <Info size={15} />
        <p>
          Cleaners accept or decline their private SMS link. Door codes are
          released only after acceptance. “Verified” requires a completed job, a
          real uploaded photo, and host review.
        </p>
      </div>
    </>
  );
}
function TaskCard({ task: t }: { task: Task }) {
  const { data, show, explain, mutate, toast } = useWorkspace();
  const l = data.listings.find((l) => l.id === t.listingId),
    cleaner = data.cleaners.find((c) => c.id === t.cleanerId);
  return (
    <article className="task-card">
      <div className="card-kicker">
        <span>{l?.name}</span>
        <button
          className="icon-button"
          aria-label="Explain cleaning task"
          onClick={() => explain(t.id)}
        >
          <Info size={15} />
        </button>
      </div>
      <h3>{t.title}</h3>
      <p className="task-date">
        <Clock size={14} />
        {dateTime(t.scheduledAt, l?.timezone)}
      </p>
      <div className="task-person">
        <UserRound size={15} />
        {cleaner?.name || "No cleaner assigned"}
      </div>
      {t.photoId && (
        <button
          className="task-photo"
          onClick={() =>
            show(
              "Cleaning verification photo",
              <img
                className="proof-image"
                src={"/api/assets/" + t.photoId}
                alt="Cleaner-submitted verification photo"
              />,
            )
          }
        >
          <Camera size={15} />
          View proof of cleaning
        </button>
      )}
      <div className="task-footer">
        {["NEEDS_SCHEDULING", "ASSIGNED", "ACCEPTED"].includes(t.status) && (
          <Button
            onClick={() =>
              show("The right person for the job", <AssignForm task={t} />)
            }
          >
            {t.cleanerId ? "Reassign" : "Assign cleaner"}
            <ArrowRight size={14} />
          </Button>
        )}
        {t.status === "DONE" && (
          <Button
            disabled={!t.photoId}
            primary
            onClick={() =>
              show(
                "Verify this turnover",
                <MutationForm
                  path={`cleaning-tasks/${t.id}/verify`}
                  label="Verify & mark ready"
                  build={() => ({ version: t.version })}
                >
                  {t.photoId && (
                    <img
                      className="proof-image"
                      src={"/api/assets/" + t.photoId}
                      alt="Photo submitted by the assigned cleaner"
                    />
                  )}
                  <p>
                    Confirm the photo meets your standard. This marks the
                    listing ready if no other overdue tasks remain.
                  </p>
                  <label className="checkbox">
                    <input type="checkbox" required />I reviewed the cleaning
                    photo.
                  </label>
                </MutationForm>,
              )
            }
          >
            <Check size={14} />
            Verify
          </Button>
        )}
        {["ACCEPTED", "IN_PROGRESS"].includes(t.status) &&
          !t.codeReleasedAt && (
            <Button
              onClick={async () => {
                try {
                  await mutate(`cleaning-tasks/${t.id}/release-code`, {});
                  toast("Access authorized for the accepted cleaner.");
                } catch (e) {
                  toast((e as Error).message);
                }
              }}
            >
              <KeyRound size={14} />
              Release code
            </Button>
          )}
        {t.status === "VERIFIED" && (
          <Button
            onClick={() =>
              show(
                "Reopen verification",
                <MutationForm
                  path={`cleaning-tasks/${t.id}/transition`}
                  build={() => ({ status: "DONE", version: t.version })}
                  label="Reopen verification"
                >
                  <p>
                    This removes the ready status so the property can be
                    reviewed again. The original verification remains in the
                    audit history.
                  </p>
                </MutationForm>,
              )
            }
          >
            Reopen review
          </Button>
        )}
      </div>
      <small className="task-deadline">
        Verify by {dateTime(t.verifyBy, l?.timezone)}
      </small>
    </article>
  );
}
function AssignForm({ task }: { task: Task }) {
  const { data } = useWorkspace();
  const eligible = data.cleaners.filter(
    (c) => c.enabled && c.listingIds.includes(task.listingId),
  );
  return eligible.length ? (
    <MutationForm
      path={`cleaning-tasks/${task.id}/assign`}
      label="Assign & queue invitation"
      build={(f) => ({ cleanerId: f.get("cleanerId"), version: task.version })}
    >
      <p className="form-intro">
        Previous assignment links will be revoked. A new private SMS link is
        queued under your cleaning automation controls.
      </p>
      <Field label="Cleaner">
        <select
          name="cleanerId"
          defaultValue={task.cleanerId || eligible[0].id}
        >
          {eligible.map((c) => (
            <option value={c.id} key={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
    </MutationForm>
  ) : (
    <Empty
      title="Add an authorized cleaner first."
      detail="Create a cleaner and include this property in their listing scope."
    />
  );
}
export function CleanerForm() {
  const { data } = useWorkspace();
  return (
    <MutationForm
      path="cleaners"
      label="Add cleaner"
      build={(f) => ({
        name: f.get("name"),
        phone: f.get("phone"),
        listingIds: f.getAll("listingIds"),
      })}
    >
      <Field label="Name">
        <input name="name" required maxLength={100} />
      </Field>
      <Field
        label="Mobile number"
        hint="Include the country code, for example +15551234567."
      >
        <input name="phone" type="tel" pattern="\+[1-9][0-9]{7,14}" required />
      </Field>
      <fieldset>
        <legend>Properties this cleaner may access</legend>
        {data.listings.map((l) => (
          <label className="checkbox" key={l.id}>
            <input type="checkbox" name="listingIds" value={l.id} />
            {l.name}
          </label>
        ))}
      </fieldset>
      <p className="microcopy">
        Cleaners receive only their assigned job, address, accepted access code,
        and photo controls. Guest contacts and prices are never returned.
      </p>
    </MutationForm>
  );
}
function TaskForm() {
  const { data } = useWorkspace();
  return (
    <MutationForm
      path="cleaning-tasks"
      label="Create task"
      build={(f) => ({
        listingId: f.get("listingId"),
        title: f.get("title"),
        scheduledAt: new Date(String(f.get("scheduledAt"))).toISOString(),
        verifyBy: new Date(String(f.get("verifyBy"))).toISOString(),
      })}
    >
      <Field label="Property">
        <select name="listingId">
          {data.listings.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Task">
        <input name="title" required defaultValue="Guest-ready turnover" />
      </Field>
      <Field label="Start time (your browser’s time zone)">
        <input type="datetime-local" name="scheduledAt" required />
      </Field>
      <Field label="Verification deadline (your browser’s time zone)">
        <input type="datetime-local" name="verifyBy" required />
      </Field>
    </MutationForm>
  );
}
