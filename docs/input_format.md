# LaTeX Input Format

For parsing a LaTeX file, the pipeline should:

1. Keep only the text between `\begin{document}` and `\end{document}`.
2. Strip all comments:
   - any line beginning with `%`
   - anything between `\begin{comment}` and `\end{comment}`
3. Extract all blocks. A block is anything between `\begin{*}` and `\end{*}`,
   where `*` is the same both times. Record what `*` is.
4. Treat `proof` blocks specially:
   - attach each proof somehow to the nearest block above it
   - if the nearest block above is also a proof, keep the proof as its own node
5. Show the user a list of every block extracted, with preview text for
   identification: the first bunch of words in the block.
6. Do not show proofs in this list unless they have been identified as their
   own block, meaning they have no associated theorem, lemma, etc.
7. Ask the user to select the target theorem from the list.
