import { useState } from "react";
import { definePluginApp, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { DiagnosticsSection } from "./components/diagnostics.js";

function Confirm({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const [pending, setPending] = useState(false);
  const payload = (interaction.payload ?? {}) as {
    label?: string; path?: string; project?: string; effects?: string[]; destructive?: boolean;
  };
  function act(action: () => Promise<unknown>) {
    setPending(true);
    void action().catch(() => setPending(false));
  }
  return (
    <section className="space-y-2 p-3" aria-label="Подтверждение операции Unica">
      <strong>{payload.label ?? interaction.title}</strong>
      <p>{payload.project}</p>
      <p className="break-all font-mono text-xs">{payload.path}</p>
      {payload.effects?.length ? <p>{payload.effects.join(", ")}</p> : null}
      {payload.destructive && <p>Операция изменяет выбранное окружение.</p>}
      <div className="flex gap-2">
        <button type="button" disabled={pending} className="rounded border px-3 py-1" onClick={() => act(cancel)}>Отмена</button>
        <button type="button" disabled={pending} className="rounded border px-3 py-1" onClick={() => act(() => submit("execute"))}>Выполнить</button>
      </div>
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({ id: "unica-confirm", component: Confirm });
  app.slots.settingsSection({ id: "diagnostics", title: "Диагностика Unica", component: DiagnosticsSection });
});
