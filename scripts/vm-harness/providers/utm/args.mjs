/** QEMU arguments the harness adds to a VM (`-vnc X`, `-qmp X`); stripped before a VM is kept as an image. */
const HARNESS_ARG = /^-(vnc|qmp)$/;

/**
 * Removes the harness's own `-vnc X` / `-qmp X` pairs from a QEMU argument list, keeping everything else.
 * @param {string[]} args
 */
export function withoutHarnessArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (HARNESS_ARG.test(args[i])) {
      i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}
