return $input.all().map((item, index) => {
  const value = item.json;
  if (value.error)
    return {
      json: {
        failed: true,
      },
      pairedItem: index,
    };
  const data =
    value.message?.content ??
    value.content ??
    value.response ??
    value.output ??
    value.text;
  try {
    const result = typeof data === "string" ? JSON.parse(data) : data;
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw Error("invalid model JSON");
    return {
      json: {
        result,
      },
      pairedItem: index,
    };
  } catch {
    return {
      json: {
        failed: true,
      },
      pairedItem: index,
    };
  }
});
