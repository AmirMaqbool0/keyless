import { z } from 'zod';
import { emailSchema } from './auth';
import { roleSchema } from './roles';

export const inviteUserSchema = z.object({ email: emailSchema, role: roleSchema });
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

export const updateUserRoleSchema = z.object({ role: roleSchema });

export const inviteDtoSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: roleSchema,
  invitedBy: z.string(),
  expiresAt: z.string(),
  createdAt: z.string(),
});
export type InviteDto = z.infer<typeof inviteDtoSchema>;

export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    country: z.string().trim().length(2).toUpperCase(),
    timezone: z.string().trim().min(1).max(64),
    currency: z.string().trim().length(3).toUpperCase(),
    settings: z
      .object({
        autoApproveEnabled: z.boolean().optional(),
        greenConfidenceThreshold: z.number().min(0).max(1).optional(),
        amberConfidenceThreshold: z.number().min(0).max(1).optional(),
        priceTolerancePct: z.number().min(0).optional(),
        highValueThreshold: z.number().nullable().optional(),
        codeDescriptionMismatchThreshold: z.number().min(0).max(1).optional(),
        retentionDays: z.number().int().min(1).optional(),
      })
      .partial()
      .optional(),
  })
  .partial();
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
