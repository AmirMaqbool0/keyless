import { Types } from 'mongoose';
import { notFound } from '@keyless/core/lib/http';

/** Parse a route id; malformed ids are simply "not found". */
export function objectId(id: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) throw notFound();
  return new Types.ObjectId(id);
}
