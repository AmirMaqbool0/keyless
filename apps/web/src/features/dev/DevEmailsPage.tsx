import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { EmptyState, Spinner } from '../../components/ui';
import { api } from '../../lib/api';

type SentMail = { id: number; to: string; subject: string; text: string; sentAt: string };

/** Development only: emails the API "sent" via the console mailer, with clickable links. */
export function DevEmailsPage() {
  const q = useQuery({
    queryKey: ['dev-emails'],
    queryFn: () => api.get<{ emails: SentMail[] }>('/api/dev/emails'),
    refetchInterval: 3000,
  });
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Dev mailbox</h1>
        <Link to="/" className="text-sm text-brand-700 hover:underline">
          Back to app
        </Link>
      </div>
      <p className="mb-6 text-sm text-slate-500">
        Emails are not really sent in development. They appear here (and in the API console).
        Restarting the API clears them.
      </p>
      {q.isPending ? (
        <Spinner />
      ) : !q.data?.emails.length ? (
        <EmptyState title="No emails yet">Sign up, invite someone or reset a password.</EmptyState>
      ) : (
        <ul className="space-y-4">
          {q.data.emails.map((m) => (
            <li key={m.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-xs">
              <div className="flex flex-wrap justify-between gap-2 text-xs text-slate-500">
                <span>To: {m.to}</span>
                <span>{new Date(m.sentAt).toLocaleString()}</span>
              </div>
              <p className="mt-1 font-medium">{m.subject}</p>
              <div className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
                {m.text.split(/(https?:\/\/\S+)/).map((part, i) =>
                  /^https?:\/\//.test(part) ? (
                    <a key={i} href={part} className="break-all text-brand-700 underline">
                      {part}
                    </a>
                  ) : (
                    <span key={i}>{part}</span>
                  ),
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
