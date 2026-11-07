import { fetchLeagueFixtures, isFixtureDate, madridToday } from '@/lib/server/espn-fixtures';
import { errorResponse, jsonError } from '@/lib/server/http';
import { isLeagueSlug } from '@/lib/ui/leagues';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const league = (params.get('league') ?? '').trim().toLowerCase();
  if (!league) {
    return jsonError(400, 'INVALID_INPUT', 'Indica la liga que quieres consultar.');
  }
  if (!isLeagueSlug(league)) {
    return jsonError(400, 'INVALID_INPUT', 'La liga debe ser un slug en minúsculas, por ejemplo eng.1.');
  }

  const requestedDate = (params.get('date') ?? '').trim();
  if (requestedDate && !isFixtureDate(requestedDate)) {
    return jsonError(400, 'INVALID_INPUT', 'La fecha debe tener el formato YYYY-MM-DD.');
  }
  const date = requestedDate || madridToday();

  try {
    const matches = await fetchLeagueFixtures(league, date);
    return Response.json(
      { league, date, timezone: 'Europe/Madrid', matches },
      {
        headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120' },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
