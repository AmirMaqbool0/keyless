import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  IMPORT_FIELDS,
  IMPORT_TYPES,
  IMPORT_TYPE_LABELS,
  type ImportJobDto,
  type ImportMapping,
  type ImportType,
} from '@keyless/shared';
import {
  Badge,
  Button,
  Card,
  FormError,
  FullPageSpinner,
  PageHeader,
  Spinner,
} from '../../components/ui';
import { api, errorMessage } from '../../lib/api';

const TYPE_HELP: Record<ImportType, string> = {
  products: 'Your catalogue: SKU, description, unit, pack size, barcode, price, stock.',
  customers: 'Account codes, names, order email addresses and delivery addresses.',
  prices:
    'Contract prices per customer, or price-list prices. Import products and customers first.',
  cross_references:
    "Customers' own part codes mapped to your SKUs. Import products and customers first.",
};

const LIST_PAGE: Record<ImportType, string> = {
  products: '/products',
  customers: '/customers',
  prices: '/customers',
  cross_references: '/cross-references',
};

const STEPS = ['Upload', 'Map columns', 'Review', 'Done'] as const;

function Steps({ current }: { current: number }) {
  return (
    <ol className="mb-6 flex flex-wrap gap-2 text-sm">
      {STEPS.map((s, i) => (
        <li
          key={s}
          className={clsx(
            'flex items-center gap-2 rounded-full px-3 py-1',
            i === current
              ? 'bg-brand-600 text-white'
              : i < current
                ? 'bg-brand-50 text-brand-700'
                : 'bg-slate-100 text-slate-500',
          )}
        >
          <span className="font-semibold">{i + 1}</span> {s}
        </li>
      ))}
    </ol>
  );
}

/** /imports/new?type=... */
export function NewImportPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const type = IMPORT_TYPES.find((t) => t === params.get('type'));
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.set('type', type!);
      form.set('file', file);
      return api.upload<{ job: ImportJobDto }>('/api/imports', form);
    },
    onSuccess: ({ job }) => navigate(`/imports/${job.id}`, { replace: true }),
  });

  if (!type) {
    return (
      <>
        <PageHeader
          title="Import data"
          description="Upload CSV files exported from your current system. Recommended order: products, customers, prices, cross-references."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          {IMPORT_TYPES.map((t, i) => (
            <button
              key={t}
              onClick={() => setParams({ type: t })}
              className="rounded-lg border border-slate-200 bg-white p-5 text-left shadow-xs transition hover:border-brand-300 hover:shadow-sm"
            >
              <p className="text-xs font-medium text-slate-400">Step {i + 1}</p>
              <p className="mt-1 font-semibold text-slate-900">{IMPORT_TYPE_LABELS[t]}</p>
              <p className="mt-1 text-sm text-slate-500">{TYPE_HELP[t]}</p>
            </button>
          ))}
        </div>
      </>
    );
  }

  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (file) upload.mutate(file);
  };

  return (
    <>
      <PageHeader
        title={`Import ${IMPORT_TYPE_LABELS[type].toLowerCase()}`}
        description={TYPE_HELP[type]}
      />
      <Steps current={0} />
      <Card>
        <FormError message={upload.error ? errorMessage(upload.error) : null} />
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            pick(e.dataTransfer.files);
          }}
          className={clsx(
            'mt-2 flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-14 text-center',
            dragging ? 'border-brand-500 bg-brand-50' : 'border-slate-300',
          )}
        >
          {upload.isPending ? (
            <div className="flex items-center gap-3 text-sm text-slate-600">
              <Spinner /> Reading file...
            </div>
          ) : (
            <>
              <p className="text-sm font-medium text-slate-800">Drag a CSV file here</p>
              <p className="mt-1 text-xs text-slate-500">
                Any column names - you will match them to Keyless fields next. Up to 100,000 rows.
              </p>
              <Button className="mt-4" onClick={() => inputRef.current?.click()}>
                Choose file
              </Button>
              <input
                ref={inputRef}
                type="file"
                accept=".csv,text/csv,.txt"
                className="hidden"
                onChange={(e) => pick(e.target.files)}
              />
            </>
          )}
        </div>
        <p className="mt-4 text-sm text-slate-500">
          Excel file? Use <em>File &gt; Save As &gt; CSV UTF-8</em>. Or{' '}
          <a
            className="text-brand-700 hover:underline"
            href={`/api/imports/templates/${type}`}
            download
          >
            download a blank template
          </a>
          .
        </p>
      </Card>
    </>
  );
}

/** /imports/:id - mapping, review and result for one upload. */
export function ImportJobPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const job = useQuery({
    queryKey: ['import', id],
    queryFn: () => api.get<{ job: ImportJobDto }>(`/api/imports/${id}`).then((r) => r.job),
  });
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  const [editingMapping, setEditingMapping] = useState(false);

  useEffect(() => {
    if (job.data && !mapping) setMapping(job.data.mapping);
  }, [job.data, mapping]);

  const onJob = (j: ImportJobDto) => {
    qc.setQueryData(['import', id], j);
    void qc.invalidateQueries({ queryKey: ['imports'] });
  };
  const validateRun = useMutation({
    mutationFn: () => api.post<{ job: ImportJobDto }>(`/api/imports/${id}/validate`, { mapping }),
    onSuccess: ({ job }) => {
      onJob(job);
      setEditingMapping(false);
    },
  });
  const commit = useMutation({
    mutationFn: () => api.post<{ job: ImportJobDto }>(`/api/imports/${id}/commit`, { mapping }),
    onSuccess: ({ job }) => {
      onJob(job);
      for (const key of [
        'products',
        'customers',
        'cross-references',
        'customer',
        'customer-prices',
      ]) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });

  if (job.isPending || !mapping) return <FullPageSpinner />;
  if (job.isError) return <FormError message={errorMessage(job.error)} />;
  const j = job.data;
  const title = `Import ${IMPORT_TYPE_LABELS[j.type].toLowerCase()}`;

  if (j.status === 'completed' || j.status === 'failed') {
    return (
      <>
        <PageHeader title={title} description={j.filename} />
        <Steps current={3} />
        <Card>
          {j.status === 'failed' ? (
            <FormError message="The import failed part-way. Nothing was lost; fix the file and try again." />
          ) : (
            <>
              <p className="text-lg font-semibold text-slate-900">Import complete</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <Stat label="New" value={j.totals.created} tone="green" />
                <Stat label="Updated" value={j.totals.updated} />
                <Stat
                  label="Skipped (errors)"
                  value={j.totals.skipped}
                  tone={j.totals.skipped ? 'red' : undefined}
                />
              </div>
            </>
          )}
          {j.errors.length > 0 && <ErrorTable job={j} />}
          <div className="mt-6 flex gap-3">
            <Link to={LIST_PAGE[j.type]}>
              <Button>View {IMPORT_TYPE_LABELS[j.type].toLowerCase()}</Button>
            </Link>
            <Link to="/imports/new">
              <Button variant="secondary">Import another file</Button>
            </Link>
          </div>
        </Card>
      </>
    );
  }

  const fields = IMPORT_FIELDS[j.type];
  const showReview = j.status === 'validated' && !editingMapping;

  if (showReview) {
    return (
      <>
        <PageHeader title={title} description={j.filename} />
        <Steps current={2} />
        <Card>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Rows in file" value={j.totals.rows} />
            <Stat label="Ready to import" value={j.totals.valid} tone="green" />
            <Stat
              label="Rows with problems"
              value={j.totals.skipped}
              tone={j.totals.skipped ? 'red' : undefined}
            />
          </div>
          {j.totals.skipped > 0 ? (
            <p className="mt-4 text-sm text-slate-600">
              Rows with problems will be skipped. Fix them in your file and import it again at any
              time - existing records are updated, not duplicated.
            </p>
          ) : (
            <p className="mt-4 text-sm text-emerald-700">Every row looks good.</p>
          )}
          {j.errors.length > 0 && <ErrorTable job={j} />}
          <FormError message={commit.error ? errorMessage(commit.error) : null} />
          <div className="mt-6 flex flex-wrap gap-3">
            <Button
              onClick={() => commit.mutate()}
              loading={commit.isPending}
              disabled={j.totals.valid === 0}
            >
              Import {j.totals.valid.toLocaleString()} rows
            </Button>
            <Button
              variant="secondary"
              onClick={() => setEditingMapping(true)}
              disabled={commit.isPending}
            >
              Change column mapping
            </Button>
          </div>
        </Card>
      </>
    );
  }

  const missingRequired = fields.filter((f) => f.required && !mapping[f.key]);
  const used = new Set(Object.values(mapping).filter(Boolean));

  return (
    <>
      <PageHeader
        title={title}
        description={`${j.filename} - ${j.totals.rows.toLocaleString()} rows`}
      />
      <Steps current={1} />
      <Card
        title="Match your columns"
        description="We guessed where we could. Required fields are marked *."
      >
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-2 font-medium">Keyless field</th>
                <th className="px-5 py-2 font-medium">Column in your file</th>
                <th className="px-5 py-2 font-medium">Sample values</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {fields.map((f) => {
                const column = mapping[f.key] ?? null;
                const samples = column
                  ? j.sampleRows
                      .slice(0, 3)
                      .map((r) => r[column])
                      .filter(Boolean)
                  : [];
                return (
                  <tr key={f.key}>
                    <td className="px-5 py-2.5">
                      <p className="font-medium text-slate-800">
                        {f.label} {f.required && <span className="text-red-600">*</span>}
                      </p>
                      {f.help && <p className="text-xs text-slate-500">{f.help}</p>}
                    </td>
                    <td className="px-5 py-2.5">
                      <select
                        aria-label={`Column for ${f.label}`}
                        value={column ?? ''}
                        onChange={(e) =>
                          setMapping({ ...mapping, [f.key]: e.target.value || null })
                        }
                        className={clsx(
                          'w-full min-w-48 rounded-md border bg-white px-2 py-1.5 text-sm',
                          f.required && !column ? 'border-red-300' : 'border-slate-300',
                        )}
                      >
                        <option value="">- not in file -</option>
                        {j.columns.map((c) => (
                          <option key={c} value={c} disabled={used.has(c) && c !== column}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="max-w-xs px-5 py-2.5 text-xs text-slate-500">
                      {samples.length
                        ? samples.map((s, i) => (
                            <span
                              key={i}
                              className="mr-2 inline-block truncate rounded bg-slate-100 px-1.5 py-0.5 font-mono"
                            >
                              {s}
                            </span>
                          ))
                        : '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <FormError message={validateRun.error ? errorMessage(validateRun.error) : null} />
        <div className="mt-6 flex items-center gap-3">
          <Button
            onClick={() => validateRun.mutate()}
            loading={validateRun.isPending}
            disabled={missingRequired.length > 0}
          >
            Check {j.totals.rows.toLocaleString()} rows
          </Button>
          {missingRequired.length > 0 && (
            <span className="text-sm text-red-600">
              Choose a column for {missingRequired.map((f) => f.label).join(', ')}
            </span>
          )}
        </div>
      </Card>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'green' | 'red' }) {
  return (
    <div className="rounded-lg border border-slate-200 px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p
        className={clsx(
          'text-2xl font-semibold',
          tone === 'green'
            ? 'text-emerald-700'
            : tone === 'red'
              ? 'text-red-600'
              : 'text-slate-900',
        )}
      >
        {value.toLocaleString()}
      </p>
    </div>
  );
}

function ErrorTable({ job }: { job: ImportJobDto }) {
  return (
    <div className="mt-6">
      <p className="mb-2 text-sm font-medium text-slate-800">
        Problems{' '}
        {job.totals.errors > job.errors.length && (
          <span className="font-normal text-slate-500">
            (first {job.errors.length} of {job.totals.errors.toLocaleString()})
          </span>
        )}
      </p>
      <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Row</th>
              <th className="px-4 py-2 font-medium">Problem</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {job.errors.map((e, i) => (
              <tr key={i}>
                <td className="px-4 py-1.5 font-mono text-xs">{e.row}</td>
                <td className="px-4 py-1.5 text-red-700">{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ImportsPage() {
  const navigate = useNavigate();
  const jobs = useQuery({
    queryKey: ['imports'],
    queryFn: () => api.get<{ items: ImportJobDto[] }>('/api/imports'),
  });
  const tone = {
    completed: 'green',
    failed: 'red',
    validated: 'amber',
    uploaded: 'slate',
  } as const;
  return (
    <>
      <PageHeader
        title="Imports"
        description="CSV uploads of products, customers, prices and cross-references."
        actions={
          <Link to="/imports/new">
            <Button>New import</Button>
          </Link>
        }
      />
      {jobs.isPending ? (
        <FullPageSpinner />
      ) : !jobs.data?.items.length ? (
        <Card>
          <p className="text-sm text-slate-600">
            No imports yet. Start with your product catalogue.
          </p>
          <Link to="/imports/new?type=products">
            <Button className="mt-4">Import products</Button>
          </Link>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 font-medium">File</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 text-right font-medium">New / updated / skipped</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {jobs.data.items.map((j) => (
                <tr
                  key={j.id}
                  className="cursor-pointer hover:bg-slate-50"
                  onClick={() => navigate(`/imports/${j.id}`)}
                >
                  <td className="whitespace-nowrap px-4 py-2.5 text-slate-500">
                    {new Date(j.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5">{IMPORT_TYPE_LABELS[j.type]}</td>
                  <td className="px-4 py-2.5">{j.filename}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={tone[j.status]}>
                      {j.status === 'uploaded'
                        ? 'needs mapping'
                        : j.status === 'validated'
                          ? 'ready to import'
                          : j.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs">
                    {j.status === 'completed'
                      ? `${j.totals.created} / ${j.totals.updated} / ${j.totals.skipped}`
                      : `${j.totals.rows} rows`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
