"use client";

import { useActionState, useRef, useState } from "react";
import { deviceAction, type DeviceState } from "@/app/actions/devices";
import { StepUpPrompt } from "@/components/passkey/StepUpPrompt";
import type { DeviceDict } from "@/lib/i18n-device";

/**
 * Approves the code the mobile app shows (ADR 0018, RFC 8628). The code field is controlled: React
 * resets uncontrolled fields after a server action, and the passkey step-up submits the form again.
 */
export function DeviceForm({ l, initialCode }: { l: DeviceDict; initialCode: string }) {
  const [state, action, pending] = useActionState<DeviceState, FormData>(deviceAction, {});
  const [code, setCode] = useState(initialCode);
  const formRef = useRef<HTMLFormElement>(null);
  if (state.ok) {
    return (
      <p className="up" role="status" data-testid="device-result">
        {state.ok === "approved" ? l.approved.replace("{d}", state.deviceName ?? "") : l.denied}
      </p>
    );
  }
  const message =
    state.error === "input" ? l.err_input : state.error === "code" ? l.err_code : state.error === "rate" ? l.err_rate : state.error === "generic" ? l.err_generic : null;
  return (
    <form ref={formRef} action={action} className="form">
      {state.error === "stepup" || state.error === "enrolPasskey" ? (
        <StepUpPrompt need={state.error} form={formRef} />
      ) : (
        message && (
          <div className="alert" role="alert">
            {message}
          </div>
        )
      )}
      <label>
        {l.code}
        <input
          name="code"
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase());
          }}
          autoComplete="off"
          maxLength={9}
          placeholder="BCDF-GHJK"
          dir="ltr"
          required
        />
      </label>
      <p className="hint">{l.warning}</p>
      <div className="btn-row">
        <button type="submit" name="decision" value="approve" className="btn" disabled={pending}>
          {l.approve}
        </button>
        <button type="submit" name="decision" value="deny" className="btn secondary" disabled={pending}>
          {l.deny}
        </button>
      </div>
    </form>
  );
}
