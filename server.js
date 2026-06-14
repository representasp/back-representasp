import express from 'express';
import axios from 'axios';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// Porta padrão do Render ou local
const PORT = process.env.PORT || 10000;

app.post('/api/login', async (req, res) => {
    const { usuario, senha } = req.body;

    if (!usuario || !senha) {
        return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
    }

    try {
        console.log(`======================================================`);
        console.log(`🚀 [BFF PRODUCTION ACTIVE] REQUISIÇÃO RECEBIDA: ${usuario.toUpperCase()}`);
        console.log(`======================================================`);

        // 1. AUTENTICAÇÃO NA SED
        const loginRes = await axios.post('https://sed.educacao.sp.gov.br/Inicio/BffAutenticar', {
            Usuario: usuario,
            Senha: senha
        });

        const cookies = loginRes.headers['set-cookie'];
        if (!cookies) {
            return res.status(401).json({ error: 'Falha na autenticação. Verifique suas credenciais.' });
        }
        const cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');

        // 2. BUSCA DE DADOS DO ALUNO E TURMA (SED)
        const configSedBase = { headers: { Cookie: cookieHeader } };
        
        const [turmasRes, calendarioRes] = await Promise.all([
            axios.get('https://sed.educacao.sp.gov.br/Inicio/BffObterTurmasAlunoAlvo', configSedBase),
            axios.get('https://sed.educacao.sp.gov.br/Inicio/BffObterCalendarioVigente', configSedBase)
        ]);

        const turma = turmasRes.data?.[0];
        if (!turma) {
            return res.status(404).json({ error: 'Nenhuma turma encontrada para este aluno.' });
        }

        const { codigoTurma, codigoEscola, codigoDiretoria } = turma;
        const de_identificador = usuario.toLowerCase();

        // 3. OBTENÇÃO DO TOKEN DO CMSP
        const tokenRes = await axios.post('https://sed.educacao.sp.gov.br/Inicio/BffObterTokenCmsp', {}, configSedBase);
        const cmspToken = tokenRes.data?.token;

        if (!cmspToken) {
            return res.status(500).json({ error: 'Não foi possível obter o token de acesso do CMSP.' });
        }

        // 4. CONFIGURAÇÃO DOS ENDPOINTS DA IP.TV
        const configIptvBase = {
            headers: {
                'Authorization': cmspToken,
                'Content-Type': 'application/json'
            }
        };

        const urlSurvey = `https://pesquisa-servico-comum.cmsp.iptv.com.br/survey/todo/count?de_identificador=${de_identificador}&cd_turma=${codigoTurma}&cd_escola=${codigoEscola}&cd_diretoria=${codigoDiretoria}`;
        const urlPendentes = `https://tms-tarefas.cmsp.iptv.com.br/tms/task/todo?de_identificador=${de_identificador}&cd_turma=${codigoTurma}&cd_escola=${codigoEscola}&cd_diretoria=${codigoDiretoria}&status=todo&sub_type=task`;
        const urlExpiradas = `https://tms-tarefas.cmsp.iptv.com.br/tms/task/todo?de_identificador=${de_identificador}&cd_turma=${codigoTurma}&cd_escola=${codigoEscola}&cd_diretoria=${codigoDiretoria}&status=expired&sub_type=task`;
        const urlRedacoes = `https://tms-tarefas.cmsp.iptv.com.br/tms/task/todo?de_identificador=${de_identificador}&cd_turma=${codigoTurma}&cd_escola=${codigoEscola}&cd_diretoria=${codigoDiretoria}&status=todo&sub_type=essay`;

        // Data de corte oficial do 2º Bimestre obtida na SED (Log #11)
        const dataInicioBimestre = new Date('2026-04-23T00:00:00.000Z');

        let avaliacoes = 0, pendentes = 0, expiradas = 0, redacoes = 0;

        // 5. DISPARO PARALELO RESILIENTE (Com tratamento de falhas em lote)
        try {
            const [surveyRes, pendentesRaw, expiradasRaw, redacoesRaw] = await Promise.all([
                axios.get(urlSurvey, configIptvBase).catch(() => ({ data: { count: 0 } })),
                axios.get(urlPendentes, configIptvBase).catch(() => ({ data: [] })),
                axios.get(urlExpiradas, configIptvBase).catch(() => ({ data: [] })),
                axios.get(urlRedacoes, configIptvBase).catch(() => ({ data: [] }))
            ]);

            // PROCESSAMENTO SEGURO DOS ARRAYS DIRETOS da IP.TV
            const rawPendentesList = Array.isArray(pendentesRaw.data) ? pendentesRaw.data : [];
            pendentes = rawPendentesList.filter(t =>
                (!t.answer_id) && t.answer_status !== 'delivered' && new Date(t.publish_at || t.start_date) >= dataInicioBimestre
            ).length;

            const rawExpiradasList = Array.isArray(expiradasRaw.data) ? expiradasRaw.data : [];
            expiradas = rawExpiradasList.filter(t =>
                (!t.answer_id) && t.answer_status !== 'delivered' && new Date(t.expire_at || t.end_date) >= dataInicioBimestre
            ).length;

            const rawRedacoesList = Array.isArray(redacoesRaw.data) ? redacoesRaw.data : [];
            redacoes = rawRedacoesList.filter(t =>
                (!t.answer_id) && t.answer_status !== 'delivered' && new Date(t.publish_at || t.start_date) >= dataInicioBimestre
            ).length;

            avaliacoes = surveyRes.data?.count || surveyRes.data?.required_count || 0;

        } catch (errBatch) {
            console.error(`⚠️ [BFF IP.TV EXCEPTION] Falha crítica inesperada no bloco IP.TV:`, errBatch.message);
        }

        // 6. RETORNO DOS DADOS LAPIDADOS PARA O FRONTEND
        return res.json({
            aluno: {
                nome: loginRes.data?.Nome || "Estudante",
                usuario: de_identificador,
                turma: turma.nomeTurma || "Não Identificada"
            },
            indicadores: {
                pendentes,
                expiradas,
                redacoes,
                avaliacoes,
                totalGeral: (pendentes + expiradas + redacoes + avaliacoes)
            }
        });

    } catch (error) {
        console.error('❌ [BFF GLOBAL ERROR]:', error.response?.data || error.message);
        return res.status(error.response?.status || 500).json({
            error: 'Erro interno no gateway BFF.',
            details: error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`BFF Gateway Operando Estavelmente na porta ${PORT}`);
});
