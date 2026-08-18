import { useEffect, useRef } from 'react';
import type { PatientRuntime } from '../game/types';
import { NURSE_QUESTIONS } from '../game/nurse';
import { clockTime } from '../game/clinical';

/**
 * The conversation with the nurse — the channel through which almost everything
 * the player learns arrives, and through which every order is placed.
 */
export function ChatThread({
  patient,
  onAsk,
  disabled,
}: {
  patient: PatientRuntime;
  onAsk: (questionId: string) => void;
  disabled: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const count = patient.messages.length;

  // Follow the conversation as it grows, but only on new messages — not on
  // every physics frame, which would fight the player trying to scroll back.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [count, patient.case.id]);

  return (
    <>
      <div className="scroll">
        <div className="thread">
          {patient.messages.length === 0 && (
            <div className="empty">
              Nothing from {patient.case.nurse} yet tonight.
              <br />
              You can ask a question or place orders at any time.
            </div>
          )}
          {patient.messages.map((m) => (
            <div
              key={m.id}
              className={[
                'msg',
                m.author,
                m.kind === 'vitals' ? 'vitals' : '',
                m.kind === 'result' ? 'result' : '',
                m.urgent ? 'urgent' : '',
              ].filter(Boolean).join(' ')}
            >
              <div className="msg-meta">
                {m.author === 'doctor' ? '' : `${m.authorName} · `}
                {clockTime(m.time)}
                {m.author === 'doctor' ? ' · you' : ''}
              </div>
              <div className="msg-body">{m.text}</div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      </div>

      <div className="ask-bar">
        {NURSE_QUESTIONS.map((q) => (
          <button
            key={q.id}
            className="ask-btn"
            disabled={disabled}
            onClick={() => onAsk(q.id)}
          >
            {q.text}
          </button>
        ))}
      </div>
    </>
  );
}
