import { corsHeaders } from '../_shared/cors.ts'
import { supabaseAdmin } from '../_shared/supabaseAdmin.ts'
import { pgPool } from '../_shared/externalDatabase.ts'

interface ChargeSessionStatistic {
  id: number
  publisher_name: string
  long: string
  lat: string
  alt: string
  updated_at: Date
  inserted_at: Date
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const client = await pgPool.connect()
  let progress
  try {
    const { data: traceData, error: traceError } = await supabaseAdmin
      .from('t_trace')
      .select('progress')
      .eq('id', 2)
      .single()

    if (traceError) {
      throw new Error(traceError.message)
    }

    progress = traceData.progress
    const res = await client.queryObject<ChargeSessionStatistic>(
      `Select id, publisher_name, long, lat, alt, updated_at, inserted_at
        from t_locate_info 
          where updated_at > $1 order by updated_at limit 100`,
      [progress]
    )

    // console.log(res.rows)

    for (const row of res.rows) {
      // const { updated_at, ...dataForUpsert } = row

      const { error: insertError } = await supabaseAdmin
        .from('locate_info ')
        .upsert({ ...row, id: row.id.toString() })
      if (insertError) {
        throw new Error(insertError.message)
      }

      progress = row.updated_at
    }

    return new Response('', {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.log(error)
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  } finally {
    client.release()

    await supabaseAdmin
      .from('t_trace')
      .update({ progress: progress })
      .eq('id', 2)
  }
})