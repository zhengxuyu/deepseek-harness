// The case's own testbench for the gate-level netlist. The dataset's testbench
// changes inputs exactly on clock edges after its first vector, so its verdict
// on a netlist depends on how the simulator orders the testbench against the
// cell models. This one changes inputs on the falling edge and samples outputs
// on the falling edge, and does not assume a pipeline latency: it waits for
// mul_en_out, for at most 16 cycles.
`timescale 1ns/1ns
module judge_tb;
  reg clk = 0;
  reg rst_n = 0;
  reg mul_en_in = 0;
  reg [7:0] mul_a = 0;
  reg [7:0] mul_b = 0;
  wire mul_en_out;
  wire [15:0] mul_out;
  integer errors = 0;
  integer vector;
  integer waited;

  multi_pipe_8bit dut (
    .clk(clk), .rst_n(rst_n), .mul_en_in(mul_en_in), .mul_a(mul_a), .mul_b(mul_b),
    .mul_en_out(mul_en_out), .mul_out(mul_out)
  );

  always #10 clk = ~clk;

  initial begin
    repeat (8) @(negedge clk);
    rst_n = 1;
    repeat (4) @(negedge clk);
    for (vector = 0; vector < 200; vector = vector + 1) begin
      mul_a = $random;
      mul_b = $random;
      mul_en_in = 1;
      waited = 0;
      @(negedge clk);
      while (mul_en_out !== 1'b1 && waited < 16) begin
        @(negedge clk);
        waited = waited + 1;
      end
      if (mul_en_out !== 1'b1 || mul_out !== mul_a * mul_b) begin
        errors = errors + 1;
        if (errors <= 5) $display("JUDGE mismatch a=%0d b=%0d out=%0d en_out=%b", mul_a, mul_b, mul_out, mul_en_out);
      end
      mul_en_in = 0;
      repeat (8) @(negedge clk);
      if (mul_en_out !== 1'b0 || mul_out !== 16'd0) begin
        errors = errors + 1;
        if (errors <= 5) $display("JUDGE not idle after the enable fell: out=%0d en_out=%b", mul_out, mul_en_out);
      end
    end
    if (errors == 0) $display("JUDGE passed");
    else $display("JUDGE failed with %0d error(s)", errors);
    $finish;
  end
endmodule
