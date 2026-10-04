/** Synthetic SSE responses for the three supported Copilot transports. */
export function transportResponse(api, model) {
  const data = (events, named = false) => events.map((event) =>
    `${named ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('');
  let body;
  if (api === 'openai-responses') {
    const item = { id: 'synthetic-message', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }] };
    body = data([
      { type: 'response.created', response: { id: 'synthetic-response', model } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: {
        id: 'synthetic-response', model, status: 'completed', output: [item],
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11,
          input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      } },
    ]);
  } else if (api === 'openai-completions') {
    body = data([
      { id: 'synthetic-chat', model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
      { id: 'synthetic-chat', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
    ]) + 'data: [DONE]\n\n';
  } else if (api === 'anthropic-messages') {
    body = data([
      { type: 'message_start', message: { id: 'synthetic-message', type: 'message', role: 'assistant', model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ], true);
  } else {
    throw new Error('Unsupported synthetic transport');
  }
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}
