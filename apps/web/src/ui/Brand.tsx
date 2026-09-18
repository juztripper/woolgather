export function Brand() {
  return (
    <span className="brand" role="img" aria-label="woolgather">
      <img
        className="brand-symbol"
        src="/brand/gather-symbol.svg"
        alt=""
        width="38"
        height="38"
      />
      <span className="brand-wordmark" aria-hidden="true">
        woolgather
      </span>
    </span>
  );
}
