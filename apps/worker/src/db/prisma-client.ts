import { PrismaClient } from '@prisma/client';
import { config } from '../config.js';

const prisma = new PrismaClient({
  datasourceUrl: config.databaseUrl,
  log: ['warn', 'error'],
});

export { prisma };

/**
 * Fetch a QueuedMessage by ID, including its Account and Attachments.
 */
export async function getJobById(id: string) {
  return prisma.queuedMessage.findUnique({
    where: { id },
    include: {
      account: true,
      attachments: true,
    },
  });
}

/**
 * Update the status of a QueuedMessage.
 */
export async function updateJobStatus(
  id: string,
  status: string,
): Promise<void> {
  await prisma.queuedMessage.update({
    where: { id },
    data: { status },
  });
}

/**
 * Update the status of an Account (e.g. to CHALLENGE_RAISED).
 */
export async function updateAccountStatus(
  id: string,
  status: string,
): Promise<void> {
  await prisma.account.update({
    where: { id },
    data: { status },
  });
}
