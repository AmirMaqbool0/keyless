import { Router, type Request } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { importMappingSchema, importTypeSchema } from '@keyless/shared';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound, param, validate } from '../../lib/http';
import type { Storage } from '../../lib/storage';
import { authed, requireRole } from '../../middleware/auth';
import { ImportJob } from '../../models/ImportJob';
import { objectId } from '../shared';
import { checkMapping, createImportJob, runImport, templateCsv, toImportJobDto } from './service';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

const mappingBody = z.object({ mapping: importMappingSchema.optional() });

/** Mounted behind requireAuth + requireVerified. All import actions are admin-only. */
export function importsRouter({ storage }: { storage: Storage }): Router {
  const r = Router();
  r.use(requireRole('admin'));

  r.get('/templates/:type', (req, res) => {
    const type = validate(importTypeSchema, param(req, 'type'));
    const { filename, body } = templateCsv(type);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  });

  r.get('/', async (req, res) => {
    const { orgId } = authed(req);
    const jobs = await ImportJob.find({ orgId }, { sampleRows: 0, rowErrors: 0 })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({
      items: jobs.map((j) => toImportJobDto({ ...j.toObject(), sampleRows: [], rowErrors: [] })),
    });
  });

  r.post('/', upload.single('file'), async (req, res) => {
    const { orgId, user } = authed(req);
    const type = validate(importTypeSchema, req.body?.type);
    if (!req.file) throw badRequest('Choose a CSV file to upload', 'NO_FILE');
    if (!/\.(csv|txt)$/i.test(req.file.originalname)) {
      throw badRequest(
        'Upload a .csv file (in Excel: File > Save As > CSV UTF-8)',
        'UNSUPPORTED_FILE',
      );
    }
    const job = await createImportJob({
      orgId,
      userId: user._id,
      type,
      filename: req.file.originalname,
      buffer: req.file.buffer,
      storage,
    });
    res.status(201).json({ job: toImportJobDto(job) });
  });

  r.get('/:id', async (req, res) => {
    const { orgId } = authed(req);
    const job = await ImportJob.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!job) throw notFound('Import not found');
    res.json({ job: toImportJobDto(job) });
  });

  async function loadOpenJob(req: Request) {
    const { orgId } = authed(req);
    const job = await ImportJob.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!job) throw notFound('Import not found');
    if (job.status === 'completed')
      throw conflict('This import has already been run', 'ALREADY_IMPORTED');
    const { mapping } = validate(mappingBody, req.body);
    if (mapping) {
      job.mapping = checkMapping(job.type, job.columns, mapping);
      job.markModified('mapping');
    } else {
      checkMapping(job.type, job.columns, job.mapping);
    }
    return job;
  }

  r.post('/:id/validate', async (req, res) => {
    const { org } = authed(req);
    const job = await runImport(await loadOpenJob(req), {
      commit: false,
      storage,
      currency: org.currency,
    });
    res.json({ job: toImportJobDto(job) });
  });

  r.post('/:id/commit', async (req, res) => {
    const { org, orgId } = authed(req);
    const job = await runImport(await loadOpenJob(req), {
      commit: true,
      storage,
      currency: org.currency,
    });
    await audit({
      orgId,
      action: 'import.completed',
      entity: { type: 'import', id: job._id.toString() },
      summary: { type: job.type, filename: job.filename, ...job.totals, status: job.status },
      req,
    });
    res.json({ job: toImportJobDto(job) });
  });

  return r;
}
