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
  })
  .partial();
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
