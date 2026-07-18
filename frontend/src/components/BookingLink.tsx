// The one "book it" action, shared verbatim by the Dashboard hero and the
// OptionDetail hero — extracted so the two heroes can't drift out of sync.
// `classSuffix` lets a caller add a scoped class alongside the shared ones
// (e.g. a scale variant) without forking the markup itself.
export function BookingLink({ url, classSuffix }: { url: string; classSuffix?: string }) {
  return (
    <a
      className={classSuffix ? `btn btn-primary hero-book ${classSuffix}` : 'btn btn-primary hero-book'}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      View on Google Flights
    </a>
  );
}
