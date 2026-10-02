import Handlebars from 'handlebars';

// The subject is always plain text (a mail header), regardless of isHtml, so
// it's never HTML-escaped. The body IS escaped when isHtml is true -- a
// member's own field value (e.g. a nickname containing "<script>") must not
// inject markup into an HTML email -- but escaping would corrupt a
// plain-text body (turning "&" into "&amp;" etc.), so that's compiled with
// noEscape instead.
export function renderEmailTemplate({ subject, body, isHtml }, context) {
  let renderedSubject;
  let renderedBody;
  try {
    renderedSubject = Handlebars.compile(subject ?? '', { noEscape: true, strict: false })(context);
    renderedBody = Handlebars.compile(body ?? '', { noEscape: !isHtml, strict: false })(context);
  } catch (err) {
    const wrapped = new Error(`Ungültige Vorlage: ${err.message}`);
    wrapped.code = 'INVALID_TEMPLATE';
    throw wrapped;
  }
  return { subject: renderedSubject, body: renderedBody };
}
